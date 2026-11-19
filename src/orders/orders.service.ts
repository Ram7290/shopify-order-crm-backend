import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShopifyClient, ShopifyConnection } from '../shopify/shopify.client.js';
import { ShopifyService } from '../shopify/shopify.service.js';
import {
  DRAFT_ORDER_COMPLETE_MUTATION,
  DRAFT_ORDER_CREATE_MUTATION,
  ORDERS_SEARCH_QUERY,
} from '../shopify/shopify.queries.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { ListOrdersQuery } from './dto/list-orders.query.js';
import { CreateRequestStatus, decideCreateAction, requestTag } from './create-request.policy.js';
import { GraphqlOrderNode, mapGraphqlOrder, NormalizedOrder } from './order-mapper.js';
import { OrdersPersistenceService } from './orders-persistence.service.js';

const SORT_FIELDS = { orderDate: 'orderDate', totalPrice: 'totalPrice' } as const;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyService,
    private readonly client: ShopifyClient,
    private readonly persistence: OrdersPersistenceService,
  ) {}

  async list(query: ListOrdersQuery) {
    const shop = await this.prisma.shop.findFirst({ orderBy: { createdAt: 'asc' } });
    const empty = { data: [], pagination: { page: query.page, pageSize: query.pageSize, total: 0, totalPages: 0 } };
    if (!shop) return empty;

    const where: Prisma.OrderWhereInput = { shopId: shop.id };
    if (query.search) {
      where.OR = [
        { orderNumber: { contains: query.search, mode: 'insensitive' } },
        { customerName: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    if (query.status) {
      where.financialStatus = query.status.toUpperCase();
    }
    if (query.startDate || query.endDate) {
      if (query.startDate && query.endDate && query.startDate > query.endDate) {
        throw new BadRequestException('startDate must be on or before endDate');
      }
      where.orderDate = {
        ...(query.startDate && { gte: new Date(`${query.startDate}T00:00:00.000Z`) }),
        ...(query.endDate && { lt: new Date(nextDay(query.endDate)) }),
      };
    }

    const sortField = SORT_FIELDS[query.sortBy];
    const [total, orders] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ [sortField]: query.sortOrder }, { id: query.sortOrder }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          orderNumber: true,
          customerName: true,
          financialStatus: true,
          fulfillmentStatus: true,
          totalPrice: true,
          currency: true,
          orderDate: true,
          source: true,
        },
      }),
    ]);

    return {
      data: orders.map((o) => ({ ...o, totalPrice: o.totalPrice.toFixed(2) })),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async findOne(id: string) {
    const shop = await this.prisma.shop.findFirst({ orderBy: { createdAt: 'asc' } });
    const order = shop
      ? await this.prisma.order.findFirst({
          where: { id, shopId: shop.id },
          include: { items: { orderBy: { title: 'asc' } } },
        })
      : null;
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return {
      ...order,
      totalPrice: order.totalPrice.toFixed(2),
      subtotalPrice: order.subtotalPrice?.toFixed(2) ?? null,
      items: order.items.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toFixed(2),
        lineTotal: item.lineTotal.toFixed(2),
      })),
    };
  }

  async createInShopify(dto: CreateOrderDto, requestKey: string) {
    const connection = await this.shopify.getConnection();
    const request = await this.claimRequest(connection.shopId, requestKey);

    if (request.action === 'return-existing') {
      return this.findOne(await this.localId(connection.shopId, request.shopifyOrderId!));
    }

    if (request.action === 'reconcile') {
      const found = await this.findOrderByRequest(connection, requestKey);
      if (found) {
        return this.saveCreated(connection.shopId, request.id, found, dto);
      }
    }

    try {
      const draft = await this.client.graphql<{
        draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
      }>(connection, DRAFT_ORDER_CREATE_MUTATION, {
        input: {
          email: dto.customer.email,
          tags: [requestTag(requestKey)],
          billingAddress: {
            firstName: dto.customer.firstName,
            lastName: dto.customer.lastName,
            phone: dto.customer.phone,
          },
          lineItems: dto.lineItems.map((item) => ({
            variantId: toVariantGid(item.variantId),
            quantity: item.quantity,
          })),
        },
      });
      if (draft.draftOrderCreate.userErrors.length || !draft.draftOrderCreate.draftOrder) {
        throw new DefiniteFailure(draft.draftOrderCreate.userErrors.map((e) => e.message).join('; ') || 'Shopify rejected the order');
      }

      const completed = await this.client.graphql<{
        draftOrderComplete: { draftOrder: { order: GraphqlOrderNode | null } | null; userErrors: { message: string }[] };
      }>(connection, DRAFT_ORDER_COMPLETE_MUTATION, { id: draft.draftOrderCreate.draftOrder.id });
      const node = completed.draftOrderComplete.draftOrder?.order;
      if (completed.draftOrderComplete.userErrors.length || !node) {
        throw new DefiniteFailure(
          completed.draftOrderComplete.userErrors.map((e) => e.message).join('; ') || 'Shopify could not complete the order',
        );
      }

      return this.saveCreated(connection.shopId, request.id, node, dto);
    } catch (error) {
      if (error instanceof DefiniteFailure) {
        await this.prisma.orderCreateRequest.update({
          where: { id: request.id },
          data: { status: 'FAILED', errorMessage: error.message.slice(0, 500) },
        });
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async claimRequest(shopId: string, requestKey: string) {
    const existing = await this.prisma.orderCreateRequest.findUnique({
      where: { shopId_requestKey: { shopId, requestKey } },
    });
    const action = decideCreateAction(
      existing && { status: existing.status as CreateRequestStatus, updatedAt: existing.updatedAt },
      new Date(),
    );

    if (action === 'in-flight') {
      throw new ConflictException('This order is already being created. Please wait a moment and try again.');
    }
    if (action === 'return-existing') {
      return { action, id: existing!.id, shopifyOrderId: existing!.shopifyOrderId };
    }
    if (!existing) {
      try {
        const created = await this.prisma.orderCreateRequest.create({
          data: { shopId, requestKey, status: 'PENDING' },
        });
        return { action: 'create' as const, id: created.id, shopifyOrderId: null };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException('This order is already being created. Please wait a moment and try again.');
        }
        throw error;
      }
    }

    const claimed = await this.prisma.orderCreateRequest.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: { status: 'PENDING', errorMessage: null },
    });
    if (claimed.count === 0) {
      throw new ConflictException('This order is already being created. Please wait a moment and try again.');
    }
    return { action, id: existing.id, shopifyOrderId: null };
  }

  private async findOrderByRequest(connection: ShopifyConnection, requestKey: string): Promise<GraphqlOrderNode | null> {
    const data = await this.client.graphql<{ orders: { nodes: GraphqlOrderNode[] } }>(connection, ORDERS_SEARCH_QUERY, {
      query: `tag:"${requestTag(requestKey)}"`,
    });
    return data.orders.nodes[0] ?? null;
  }

  private async saveCreated(shopId: string, requestId: string, node: GraphqlOrderNode, dto: CreateOrderDto) {
    const order: NormalizedOrder = mapGraphqlOrder(node);
    if (!order.customer) {
      order.customerName = `${dto.customer.firstName} ${dto.customer.lastName}`;
      order.customerEmail = dto.customer.email;
    }
    await this.persistence.upsertOrder(shopId, order, 'CRM');
    await this.prisma.orderCreateRequest.update({
      where: { id: requestId },
      data: { status: 'SUCCEEDED', shopifyOrderId: order.shopifyOrderId, errorMessage: null },
    });
    return this.findOne(await this.localId(shopId, order.shopifyOrderId));
  }

  private async localId(shopId: string, shopifyOrderId: string): Promise<string> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { shopId_shopifyOrderId: { shopId, shopifyOrderId } },
      select: { id: true },
    });
    return order.id;
  }
}

class DefiniteFailure extends Error {}

function toVariantGid(variantId: string): string {
  return /^\d+$/.test(variantId) ? `gid://shopify/ProductVariant/${variantId}` : variantId;
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}
