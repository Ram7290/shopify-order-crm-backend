import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyOauthQueryHmac, verifyWebhookHmac } from './hmac.util.js';

const SECRET = 'test-secret';

describe('verifyWebhookHmac', () => {
  const body = Buffer.from('{"id":1001}');
  const validHeader = createHmac('sha256', SECRET).update(body).digest('base64');

  it('accepts a signature computed over the raw body', () => {
    expect(verifyWebhookHmac(body, validHeader, SECRET)).toBe(true);
  });

  it('rejects a payload that was changed after signing', () => {
    expect(verifyWebhookHmac(Buffer.from('{"id":1002}'), validHeader, SECRET)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyWebhookHmac(body, validHeader, 'other-secret')).toBe(false);
  });
});

describe('verifyOauthQueryHmac', () => {
  function signQuery(params: Record<string, string>): Record<string, string> {
    const message = Object.keys(params)
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join('&');
    return { ...params, hmac: createHmac('sha256', SECRET).update(message).digest('hex') };
  }

  it('accepts a query signed with the app secret', () => {
    const query = signQuery({ code: 'abc', shop: 'demo.myshopify.com', state: 'xyz', timestamp: '1' });
    expect(verifyOauthQueryHmac(query, SECRET)).toBe(true);
  });

  it('rejects a query whose parameters were altered', () => {
    const query = signQuery({ code: 'abc', shop: 'demo.myshopify.com', state: 'xyz', timestamp: '1' });
    expect(verifyOauthQueryHmac({ ...query, shop: 'evil.myshopify.com' }, SECRET)).toBe(false);
  });

  it('rejects a query with no hmac', () => {
    expect(verifyOauthQueryHmac({ code: 'abc', shop: 'demo.myshopify.com' }, SECRET)).toBe(false);
  });
});
