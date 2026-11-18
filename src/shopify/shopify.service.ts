import { BadRequestException, BadGatewayException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt } from '../common/crypto.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { verifyOauthQueryHmac } from './hmac.util.js';
import { ShopifyClient, ShopifyConnection } from './shopify.client.js';
import { WEBHOOK_SUBSCRIPTION_CREATE_MUTATION } from './shopify.queries.js';

const ORDER_WEBHOOK_TOPICS = ['ORDERS_CREATE', 'ORDERS_UPDATED'];

const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const REFRESH_BEFORE_EXPIRY_MS = 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  scope: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
}

@Injectable()
export class ShopifyService {
  private readonly logger = new Logger(ShopifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: ShopifyClient,
  ) {}

  get apiSecret(): string {
    return this.config.getOrThrow<string>('SHOPIFY_API_SECRET');
  }

  buildInstallUrl(shopDomain: string): string {
    assertShopDomain(shopDomain);
    const params = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('SHOPIFY_API_KEY'),
      scope: this.config.getOrThrow<string>('SHOPIFY_SCOPES'),
      redirect_uri: this.callbackUrl(),
      state: this.createState(shopDomain),
    });
    return `https://${shopDomain}/admin/oauth/authorize?${params.toString()}`;
  }

  async completeInstall(query: Record<string, string>): Promise<string> {
    if (!verifyOauthQueryHmac(query, this.apiSecret)) {
      throw new UnauthorizedException('Invalid Shopify signature');
    }
    const shopDomain = query.shop;
    assertShopDomain(shopDomain);
    this.verifyState(query.state, shopDomain);

    const token = await this.requestToken(shopDomain, {
      code: query.code,
      expiring: '1',
    });
    const key = this.encryptionKey();

    const tokenFields = {
      accessTokenEncrypted: encrypt(token.access_token, key),
      accessTokenExpiresAt: expiresAt(token.expires_in),
      refreshTokenEncrypted: token.refresh_token ? encrypt(token.refresh_token, key) : null,
      scopes: token.scope,
    };
    await this.prisma.shop.upsert({
      where: { shopDomain },
      create: { shopDomain, ...tokenFields },
      update: tokenFields,
    });
    await this.registerOrderWebhooks({ shopDomain, accessToken: token.access_token });
    return shopDomain;
  }

  private async registerOrderWebhooks(connection: ShopifyConnection): Promise<void> {
    const uri = `${this.config.getOrThrow<string>('SHOPIFY_APP_URL')}/api/webhooks/shopify`;
    for (const topic of ORDER_WEBHOOK_TOPICS) {
      const result = await this.client.graphql<{
        webhookSubscriptionCreate: { userErrors: { message: string }[] };
      }>(connection, WEBHOOK_SUBSCRIPTION_CREATE_MUTATION, {
        topic,
        webhookSubscription: { uri, format: 'JSON' },
      });
      const errors = result.webhookSubscriptionCreate.userErrors;
      if (errors.length) {
        this.logger.warn(`Webhook ${topic} not registered: ${errors.map((e) => e.message).join('; ')}`);
      }
    }
  }

  async getConnection(): Promise<ShopifyConnection & { shopId: string }> {
    const shop = await this.prisma.shop.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!shop) {
      throw new NotFoundException('No Shopify store is connected. Install the app first.');
    }

    const key = this.encryptionKey();
    let accessToken = decrypt(shop.accessTokenEncrypted, key);
    const expiresSoon = shop.accessTokenExpiresAt && shop.accessTokenExpiresAt.getTime() - Date.now() < REFRESH_BEFORE_EXPIRY_MS;
    if (expiresSoon) {
      accessToken = await this.refreshAccessToken(shop.id, shop.shopDomain, shop.refreshTokenEncrypted);
    }

    return { shopId: shop.id, shopDomain: shop.shopDomain, accessToken };
  }

  async getStatus() {
    const shop = await this.prisma.shop.findFirst({ orderBy: { createdAt: 'asc' } });
    return shop
      ? { connected: true, shopDomain: shop.shopDomain, scopes: shop.scopes, connectedAt: shop.createdAt }
      : { connected: false };
  }

  private async refreshAccessToken(shopId: string, shopDomain: string, refreshTokenEncrypted: string | null): Promise<string> {
    if (!refreshTokenEncrypted) {
      throw new UnauthorizedException('Shopify access expired. Reinstall the app to reconnect.');
    }
    const key = this.encryptionKey();
    const refreshToken = decrypt(refreshTokenEncrypted, key);
    const token = await this.requestToken(shopDomain, { refresh_token: refreshToken, grant_type: 'refresh_token' });

    await this.prisma.shop.update({
      where: { id: shopId },
      data: {
        accessTokenEncrypted: encrypt(token.access_token, key),
        accessTokenExpiresAt: expiresAt(token.expires_in),
        refreshTokenEncrypted: token.refresh_token ? encrypt(token.refresh_token, key) : refreshTokenEncrypted,
      },
    });
    return token.access_token;
  }

  private encryptionKey(): string {
    return this.config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY');
  }

  private callbackUrl(): string {
    return `${this.config.getOrThrow<string>('SHOPIFY_APP_URL')}/api/shopify/callback`;
  }

  private createState(shopDomain: string): string {
    const payload = Buffer.from(JSON.stringify({ shop: shopDomain, nonce: randomBytes(12).toString('hex'), ts: Date.now() })).toString('base64url');
    const signature = createHmac('sha256', this.apiSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private verifyState(state: string | undefined, shopDomain: string): void {
    const [payload, signature] = (state ?? '').split('.');
    if (!payload || !signature) throw new UnauthorizedException('Invalid install state');

    const expected = createHmac('sha256', this.apiSecret).update(payload).digest('base64url');
    const valid = expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    if (!valid) throw new UnauthorizedException('Invalid install state');

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { shop: string; ts: number };
    if (data.shop !== shopDomain || Date.now() - data.ts > STATE_MAX_AGE_MS) {
      throw new UnauthorizedException('Install state expired or mismatched');
    }
  }

  private async requestToken(shopDomain: string, fields: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('SHOPIFY_API_KEY'),
      client_secret: this.apiSecret,
      ...fields,
    });

    let response: Response;
    try {
      response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
      });
    } catch {
      throw new BadGatewayException('Could not reach Shopify');
    }
    if (!response.ok) {
      throw new BadRequestException('Shopify rejected the token request. Reinstall the app if this persists.');
    }
    return (await response.json()) as TokenResponse;
  }
}

function expiresAt(expiresIn: number | undefined): Date | null {
  return expiresIn && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;
}

function assertShopDomain(shopDomain: string | undefined): asserts shopDomain is string {
  if (!shopDomain || !SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    throw new BadRequestException('Shop must be a valid *.myshopify.com domain');
  }
}
