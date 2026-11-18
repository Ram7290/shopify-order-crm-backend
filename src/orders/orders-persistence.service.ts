import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { NormalizedOrder } from './order-mapper.js';

export type UpsertOutcome = 'created' | 'updated' | 'skipped';

@Injectable()
export class OrdersPersistenceService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertOrder(shopId: string, order: NormalizedOrder, source: 'SHOPIFY' | 'CRM'): Promise<UpsertOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.order.findUnique({
        where: { shopId_shopifyOrderId: { shopId, shopifyOrderId: order.shopifyOrderId } },
        select: { id: true, shopifyUpdatedAt: true },
      });

      if (existing && existing.shopifyUpdatedAt > order.shopifyUpdatedAt) {
        return 'skipped';
      }

      let customerId: string | null = null;
      if (order.customer) {
        const customer = await tx.customer.upsert({
          where: { shopId_shopifyCustomerId: { shopId, shopifyCustomerId: order.customer.shopifyCustomerId } },
          create: { shopId, ...order.customer },
          update: {
            email: order.customer.email,
            firstName: order.customer.firstName,
            lastName: order.customer.lastName,
            phone: order.customer.phone,
          },
        });
        customerId = customer.id;
      }

      const fields = {
        customerId,
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        financialStatus: order.financialStatus,
        fulfillmentStatus: order.fulfillmentStatus,
        currency: order.currency,
        subtotalPrice: order.subtotalPrice,
        totalPrice: order.totalPrice,
        orderDate: order.orderDate,
        shopifyUpdatedAt: order.shopifyUpdatedAt,
      };

      const saved = await tx.order.upsert({
        where: { shopId_shopifyOrderId: { shopId, shopifyOrderId: order.shopifyOrderId } },
        create: { shopId, shopifyOrderId: order.shopifyOrderId, source, ...fields },
        update: fields,
      });

      await tx.orderItem.deleteMany({ where: { orderId: saved.id } });
      await tx.orderItem.createMany({
        data: order.items.map((item) => ({ orderId: saved.id, ...item })),
      });

      return existing ? 'updated' : 'created';
    });
  }
}
