// End-to-end checks against a running backend.
//
// Usage (see README "End-to-end tests"):
//   E2E_BASE_URL=http://localhost:3000/api \
//   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... \
//   SHOPIFY_API_SECRET=... SHOP_DOMAIN=your-store.myshopify.com \
//   node test/e2e/e2e.mjs
//
// Optional:
//   E2E_VARIANT_ID=68729721815346   create an order in Shopify (creates a real order!)
//   E2E_SKIP_SHOPIFY=1              skip checks that call the Shopify API (sync, create)
//   E2E_RATE_LIMIT=1                check login rate limiting (locks login for 15 minutes)
//
// Webhook checks insert test rows with order numbers starting "#E2E-".
// Remove them with: DELETE FROM "Order" WHERE "orderNumber" LIKE '#E2E-%';

import { createHmac, randomUUID } from 'node:crypto';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000/api';
const ADMIN_EMAIL = required('ADMIN_EMAIL');
const ADMIN_PASSWORD = required('ADMIN_PASSWORD');
const SHOPIFY_API_SECRET = required('SHOPIFY_API_SECRET');
const SHOP_DOMAIN = required('SHOP_DOMAIN');
const VARIANT_ID = process.env.E2E_VARIANT_ID;
const SKIP_SHOPIFY = process.env.E2E_SKIP_SHOPIFY === '1';
const RATE_LIMIT = process.env.E2E_RATE_LIMIT === '1';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing environment variable ${name}. See the header of test/e2e/e2e.mjs.`);
    process.exit(2);
  }
  return value;
}

const results = [];
let token = null;

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(method, path, { auth = true, body, headers = {}, raw } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function webhookPayload(overrides = {}) {
  return {
    id: 990001,
    admin_graphql_api_id: 'gid://shopify/Order/990001',
    name: '#E2E-1',
    created_at: '2026-01-10T10:00:00Z',
    updated_at: '2026-01-10T10:00:00Z',
    currency: 'USD',
    email: 'e2e-webhook@example.com',
    financial_status: 'paid',
    fulfillment_status: null,
    subtotal_price: '10.00',
    total_price: '10.00',
    customer: null,
    line_items: [{ id: 1, variant_id: null, title: 'E2E item', sku: null, quantity: 1, price: '10.00' }],
    ...overrides,
  };
}

async function sendWebhook(topic, webhookId, payload, { signature } = {}) {
  const raw = JSON.stringify(payload);
  const hmac = signature ?? createHmac('sha256', SHOPIFY_API_SECRET).update(raw).digest('base64');
  return call('POST', '/webhooks/shopify', {
    auth: false,
    raw,
    headers: {
      'X-Shopify-Hmac-Sha256': hmac,
      'X-Shopify-Topic': topic,
      'X-Shopify-Shop-Domain': SHOP_DOMAIN,
      'X-Shopify-Webhook-Id': webhookId,
    },
  });
}

console.log(`E2E against ${BASE}\n`);

console.log('Authentication');
await check('login rejects a wrong password', async () => {
  const res = await call('POST', '/auth/login', { auth: false, body: { email: ADMIN_EMAIL, password: 'wrong-password-x' } });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});
await check('login validates the email format', async () => {
  const res = await call('POST', '/auth/login', { auth: false, body: { email: 'not-an-email', password: 'whatever1' } });
  assert(res.status === 400, `expected 400, got ${res.status}`);
});
await check('login succeeds with the admin account', async () => {
  const res = await call('POST', '/auth/login', { auth: false, body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert(res.status === 200 && res.data?.accessToken, `expected 200 with a token, got ${res.status}`);
  token = res.data.accessToken;
});
await check('protected routes reject requests without a token', async () => {
  const res = await call('GET', '/orders', { auth: false });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

console.log('\nShopify connection');
await check('store is connected to the expected shop', async () => {
  const res = await call('GET', '/shopify/status');
  assert(res.data?.connected === true, 'store is not connected');
  assert(res.data.shopDomain === SHOP_DOMAIN, `connected to ${res.data.shopDomain}`);
});
if (!SKIP_SHOPIFY) {
  await check('sync imports orders without failures', async () => {
    const res = await call('POST', '/orders/sync');
    assert(res.status === 201 || res.status === 200, `expected success, got ${res.status}`);
    assert(res.data.failed === 0, `${res.data.failed} orders failed to import`);
  });
}

console.log('\nOrder list');
await check('list returns the requested page size', async () => {
  const res = await call('GET', '/orders?page=1&pageSize=2');
  assert(res.status === 200, `status ${res.status}`);
  assert(res.data.data.length <= 2, 'more rows than pageSize');
  assert(res.data.pagination.pageSize === 2, 'pagination metadata missing');
});
await check('search for a missing order returns an empty list', async () => {
  const res = await call('GET', `/orders?search=${randomUUID()}`);
  assert(res.status === 200 && res.data.data.length === 0, 'expected no rows');
});
await check('status filter only returns matching rows', async () => {
  const res = await call('GET', '/orders?status=PAID');
  assert(res.data.data.every((o) => o.financialStatus === 'PAID'), 'a non-PAID order was returned');
});
await check('sort by total is ascending when requested', async () => {
  const res = await call('GET', '/orders?sortBy=totalPrice&sortOrder=asc&pageSize=100');
  const totals = res.data.data.map((o) => Number(o.totalPrice));
  assert(totals.every((t, i) => i === 0 || totals[i - 1] <= t), 'totals are not ascending');
});
await check('reversed date range is rejected', async () => {
  const res = await call('GET', '/orders?startDate=2026-12-01&endDate=2026-01-01');
  assert(res.status === 400, `expected 400, got ${res.status}`);
});
await check('page size above 100 is rejected', async () => {
  const res = await call('GET', '/orders?pageSize=500');
  assert(res.status === 400, `expected 400, got ${res.status}`);
});
await check('unknown order returns 404', async () => {
  const res = await call('GET', `/orders/${randomUUID()}`);
  assert(res.status === 404, `expected 404, got ${res.status}`);
});

console.log('\nWebhooks');
await check('webhook with a forged signature is rejected', async () => {
  const res = await sendWebhook('orders/create', `e2e-forged-${randomUUID()}`, webhookPayload(), { signature: 'forged' });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});
await check('webhook signed with the wrong secret is rejected', async () => {
  const raw = JSON.stringify(webhookPayload());
  const hmac = createHmac('sha256', 'wrong-secret').update(raw).digest('base64');
  const res = await sendWebhook('orders/create', `e2e-wrong-${randomUUID()}`, webhookPayload(), { signature: hmac });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

const webhookId = `e2e-create-${randomUUID()}`;
await check('valid orders/create webhook is processed', async () => {
  const res = await sendWebhook('orders/create', webhookId, webhookPayload());
  assert(res.data?.status === 'PROCESSED', `expected PROCESSED, got ${JSON.stringify(res.data)}`);
});
await check('repeated delivery is detected as a duplicate', async () => {
  const res = await sendWebhook('orders/create', webhookId, webhookPayload());
  assert(res.data?.status === 'duplicate', `expected duplicate, got ${JSON.stringify(res.data)}`);
});
await check('stale orders/updated does not overwrite newer data', async () => {
  const stale = webhookPayload({ updated_at: '2026-01-09T10:00:00Z', total_price: '99.00' });
  await sendWebhook('orders/updated', `e2e-stale-${randomUUID()}`, stale);
  const res = await call('GET', '/orders?search=E2E-1');
  const order = res.data.data[0];
  assert(order && order.totalPrice === '10.00', `total changed to ${order?.totalPrice}`);
});
await check('newer orders/updated is applied', async () => {
  const newer = webhookPayload({ updated_at: '2026-01-11T10:00:00Z', total_price: '25.00', fulfillment_status: 'fulfilled' });
  await sendWebhook('orders/updated', `e2e-newer-${randomUUID()}`, newer);
  const res = await call('GET', '/orders?search=E2E-1');
  const order = res.data.data[0];
  assert(order && order.totalPrice === '25.00', `total is ${order?.totalPrice}`);
  assert(order.fulfillmentStatus === 'FULFILLED', `fulfillment is ${order.fulfillmentStatus}`);
});

console.log('\nCreate order');
await check('create order without an Idempotency-Key is rejected', async () => {
  const res = await call('POST', '/orders', {
    body: { customer: { email: 'e2e@example.com', firstName: 'E', lastName: '2E' }, lineItems: [{ variantId: '1', quantity: 1 }] },
  });
  assert(res.status === 400, `expected 400, got ${res.status}`);
});
await check('create order rejects zero quantity', async () => {
  const res = await call('POST', '/orders', {
    headers: { 'Idempotency-Key': randomUUID() },
    body: { customer: { email: 'e2e@example.com', firstName: 'E', lastName: '2E' }, lineItems: [{ variantId: '1', quantity: 0 }] },
  });
  assert(res.status === 400, `expected 400, got ${res.status}`);
});
if (VARIANT_ID && !SKIP_SHOPIFY) {
  const key = randomUUID();
  const body = {
    customer: { email: `e2e-${key.slice(0, 8)}@example.com`, firstName: 'E2E', lastName: 'Create' },
    lineItems: [{ variantId: VARIANT_ID, quantity: 1 }],
  };
  let first;
  await check('create order saves the Shopify order locally', async () => {
    const res = await call('POST', '/orders', { headers: { 'Idempotency-Key': key }, body });
    assert(res.status === 201 || res.status === 200, `expected success, got ${res.status} ${JSON.stringify(res.data)}`);
    assert(res.data.source === 'CRM', `source is ${res.data.source}`);
    first = res.data;
  });
  await check('repeating the same Idempotency-Key returns the same order', async () => {
    const res = await call('POST', '/orders', { headers: { 'Idempotency-Key': key }, body });
    assert(res.data?.id === first?.id, 'a different order was returned');
  });
} else {
  console.log('  SKIP  create order against Shopify (set E2E_VARIANT_ID to enable)');
}

if (RATE_LIMIT) {
  console.log('\nRate limiting');
  await check('login is blocked after repeated failures', async () => {
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const res = await call('POST', '/auth/login', { auth: false, body: { email: ADMIN_EMAIL, password: 'wrong-password-x' } });
      codes.push(res.status);
    }
    assert(codes[5] === 429, `expected 429 on attempt 6, got ${codes.join(', ')}`);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
