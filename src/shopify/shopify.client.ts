import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ShopifyConnection {
  shopDomain: string;
  accessToken: string;
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const MAX_ATTEMPTS = 4;

@Injectable()
export class ShopifyClient {
  constructor(private readonly config: ConfigService) {}

  async graphql<T>(connection: ShopifyConnection, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const version = this.config.getOrThrow<string>('SHOPIFY_API_VERSION');
    const url = `https://${connection.shopDomain}/admin/api/${version}/graphql.json`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': connection.accessToken,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        if (attempt === MAX_ATTEMPTS) {
          throw new ServiceUnavailableException('Could not reach Shopify. Please try again.');
        }
        await sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 429 || response.status === 503) {
        if (attempt === MAX_ATTEMPTS) {
          throw new ServiceUnavailableException('Shopify rate limit reached. Please try again shortly.');
        }
        await sleep(retryAfterMs(response) ?? backoffMs(attempt));
        continue;
      }

      if (!response.ok) {
        throw new BadGatewayException(`Shopify returned HTTP ${response.status}`);
      }

      const body = (await response.json()) as GraphqlResponse<T>;
      const throttled = body.errors?.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && attempt < MAX_ATTEMPTS) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (body.errors?.length) {
        throw new BadGatewayException(`Shopify GraphQL error: ${body.errors[0].message}`);
      }
      if (!body.data) {
        throw new BadGatewayException('Shopify returned an empty response');
      }
      return body.data;
    }

    throw new ServiceUnavailableException('Shopify is unavailable. Please try again.');
  }
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
