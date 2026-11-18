import { createHmac, timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyWebhookHmac(rawBody: Buffer, headerValue: string, secret: string): boolean {
  const digest = createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, headerValue);
}

export function verifyOauthQueryHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, signature: _signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${rest[key]}`)
    .join('&');
  const digest = createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(digest, hmac);
}
