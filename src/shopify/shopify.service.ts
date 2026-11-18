import { BadRequestException, BadGatewayException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { decrypt, encrypt } from '../common/crypto.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { verifyOauthQueryHmac } from './hmac.util.js';
import { ShopifyConnection } from './shopify.client.js';

const SHOP_DOMAIN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

@Injectable()
export class ShopifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

    const accessToken = await this.exchangeCodeForToken(shopDomain, query.code);
    const encryptionKey = this.config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY');

    await this.prisma.shop.upsert({
      where: { shopDomain },
      create: {
        shopDomain,
        accessTokenEncrypted: encrypt(accessToken.token, encryptionKey),
        scopes: accessToken.scope,
      },
      update: {
        accessTokenEncrypted: encrypt(accessToken.token, encryptionKey),
        scopes: accessToken.scope,
      },
    });
    return shopDomain;
  }

  async getConnection(): Promise<ShopifyConnection & { shopId: string }> {
    const shop = await this.prisma.shop.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!shop) {
      throw new NotFoundException('No Shopify store is connected. Install the app first.');
    }
    return {
      shopId: shop.id,
      shopDomain: shop.shopDomain,
      accessToken: decrypt(shop.accessTokenEncrypted, this.config.getOrThrow<string>('TOKEN_ENCRYPTION_KEY')),
    };
  }

  async getStatus() {
    const shop = await this.prisma.shop.findFirst({ orderBy: { createdAt: 'asc' } });
    return shop
      ? { connected: true, shopDomain: shop.shopDomain, scopes: shop.scopes, connectedAt: shop.createdAt }
      : { connected: false };
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

  private async exchangeCodeForToken(shopDomain: string, code: string): Promise<{ token: string; scope: string }> {
    let response: Response;
    try {
      response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.config.getOrThrow<string>('SHOPIFY_API_KEY'),
          client_secret: this.apiSecret,
          code,
        }),
      });
    } catch {
      throw new BadGatewayException('Could not reach Shopify to complete the install');
    }
    if (!response.ok) {
      throw new BadRequestException('Shopify rejected the install code');
    }
    const body = (await response.json()) as { access_token: string; scope: string };
    return { token: body.access_token, scope: body.scope };
  }
}

function assertShopDomain(shopDomain: string | undefined): asserts shopDomain is string {
  if (!shopDomain || !SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    throw new BadRequestException('Shop must be a valid *.myshopify.com domain');
  }
}
