import { Injectable, Logger } from '@nestjs/common';
import { ShopifyClient } from '../shopify/shopify.client.js';
import { ShopifyService } from '../shopify/shopify.service.js';
import { ORDERS_PAGE_QUERY } from '../shopify/shopify.queries.js';
import { GraphqlOrderNode, mapGraphqlOrder } from './order-mapper.js';
import { OrdersPersistenceService } from './orders-persistence.service.js';

interface OrdersPageResponse {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GraphqlOrderNode[];
  };
}

export interface SyncSummary {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

const PAGE_SIZE = 50;

@Injectable()
export class OrdersSyncService {
  private readonly logger = new Logger(OrdersSyncService.name);

  constructor(
    private readonly shopify: ShopifyService,
    private readonly client: ShopifyClient,
    private readonly persistence: OrdersPersistenceService,
  ) {}

  async syncAll(): Promise<SyncSummary> {
    const connection = await this.shopify.getConnection();
    const summary: SyncSummary = { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
    let after: string | null = null;

    do {
      const page: OrdersPageResponse = await this.client.graphql<OrdersPageResponse>(connection, ORDERS_PAGE_QUERY, {
        first: PAGE_SIZE,
        after,
      });

      for (const node of page.orders.nodes) {
        summary.fetched++;
        try {
          const outcome = await this.persistence.upsertOrder(connection.shopId, mapGraphqlOrder(node), 'SHOPIFY');
          summary[outcome === 'created' ? 'created' : outcome === 'updated' ? 'updated' : 'skipped']++;
        } catch (error) {
          summary.failed++;
          this.logger.error(`Failed to import ${node.name}: ${(error as Error).message}`);
        }
      }

      after = page.orders.pageInfo.hasNextPage ? page.orders.pageInfo.endCursor : null;
    } while (after);

    return summary;
  }
}
