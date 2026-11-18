import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../generated/prisma/client.js';
import { OrdersPersistenceService } from '../orders/orders-persistence.service.js';
import { mapWebhookOrder, WebhookOrderPayload } from '../orders/order-mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { verifyWebhookHmac } from '../shopify/hmac.util.js';

const ORDER_TOPICS = new Set(['orders/create', 'orders/updated']);

export interface WebhookHeaders {
  hmac?: string;
  topic?: string;
  shopDomain?: string;
  webhookId?: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly persistence: OrdersPersistenceService,
  ) {}

  async handle(headers: WebhookHeaders, rawBody: Buffer): Promise<{ status: string }> {
    const secret = this.config.getOrThrow<string>('SHOPIFY_API_SECRET');
    if (!headers.hmac || !verifyWebhookHmac(rawBody, headers.hmac, secret)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (!headers.topic || !headers.shopDomain || !headers.webhookId) {
      throw new BadRequestException('Missing Shopify webhook headers');
    }

    const shop = await this.prisma.shop.findUnique({ where: { shopDomain: headers.shopDomain } });
    if (!shop) {
      throw new NotFoundException('Unknown shop');
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as unknown;
    const eventId = headers.webhookId;

    const duplicate = await this.registerEvent(shop.id, eventId, headers.topic, payload);
    if (duplicate) {
      return { status: 'duplicate' };
    }

    try {
      let status = 'IGNORED';
      if (ORDER_TOPICS.has(headers.topic)) {
        await this.persistence.upsertOrder(shop.id, mapWebhookOrder(payload as WebhookOrderPayload), 'SHOPIFY');
        status = 'PROCESSED';
      }
      await this.prisma.webhookEvent.update({
        where: { shopId_eventId: { shopId: shop.id, eventId } },
        data: { status, processedAt: new Date(), errorMessage: null },
      });
      return { status };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Webhook ${eventId} (${headers.topic}) failed: ${message}`);
      await this.prisma.webhookEvent.update({
        where: { shopId_eventId: { shopId: shop.id, eventId } },
        data: { status: 'FAILED', errorMessage: message.slice(0, 1000) },
      });
      throw error;
    }
  }

  /**
   * Returns true when this delivery was already processed successfully.
   * Failed or interrupted deliveries are reprocessed; upserts make that safe.
   */
  private async registerEvent(shopId: string, eventId: string, topic: string, payload: unknown): Promise<boolean> {
    try {
      await this.prisma.webhookEvent.create({
        data: { shopId, eventId, topic, status: 'RECEIVED', payload: payload as Prisma.InputJsonValue },
      });
      return false;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const existing = await this.prisma.webhookEvent.findUniqueOrThrow({
        where: { shopId_eventId: { shopId, eventId } },
        select: { status: true },
      });
      if (existing.status === 'PROCESSED' || existing.status === 'IGNORED') {
        return true;
      }
      await this.prisma.webhookEvent.update({
        where: { shopId_eventId: { shopId, eventId } },
        data: { status: 'RECEIVED', errorMessage: null },
      });
      return false;
    }
  }
}
