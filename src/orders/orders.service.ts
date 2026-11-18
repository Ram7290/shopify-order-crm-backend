import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShopifyClient } from '../shopify/shopify.client.js';
import { ShopifyService } from '../shopify/shopify.service.js';
import { DRAFT_ORDER_COMPLETE_MUTATION, DRAFT_ORDER_CREATE_MUTATION } from '../shopify/shopify.queries.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { ListOrdersQuery } from './dto/list-orders.query.js';
import { GraphqlOrderNode, mapGraphqlOrder } from './order-mapper.js';
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

  async createInShopify(dto: CreateOrderDto) {
    const connection = await this.shopify.getConnection();

    const draft = await this.client.graphql<{
      draftOrderCreate: { draftOrder: { id: string } | null; userErrors: { message: string }[] };
    }>(connection, DRAFT_ORDER_CREATE_MUTATION, {
      input: {
        email: dto.customer.email,
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
      throw new BadRequestException(draft.draftOrderCreate.userErrors.map((e) => e.message).join('; ') || 'Shopify rejected the order');
    }

    const completed = await this.client.graphql<{
      draftOrderComplete: { draftOrder: { order: GraphqlOrderNode | null } | null; userErrors: { message: string }[] };
    }>(connection, DRAFT_ORDER_COMPLETE_MUTATION, { id: draft.draftOrderCreate.draftOrder.id });
    const node = completed.draftOrderComplete.draftOrder?.order;
    if (completed.draftOrderComplete.userErrors.length || !node) {
      throw new BadRequestException(
        completed.draftOrderComplete.userErrors.map((e) => e.message).join('; ') || 'Shopify could not complete the order',
      );
    }

    const order = mapGraphqlOrder(node);
    if (!order.customer) {
      order.customerName = `${dto.customer.firstName} ${dto.customer.lastName}`;
      order.customerEmail = dto.customer.email;
    }
    await this.persistence.upsertOrder(connection.shopId, order, 'CRM');
    return this.findOne(await this.localId(connection.shopId, order.shopifyOrderId));
  }

  private async localId(shopId: string, shopifyOrderId: string): Promise<string> {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { shopId_shopifyOrderId: { shopId, shopifyOrderId } },
      select: { id: true },
    });
    return order.id;
  }
}

function toVariantGid(variantId: string): string {
  return /^\d+$/.test(variantId) ? `gid://shopify/ProductVariant/${variantId}` : variantId;
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString();
}
