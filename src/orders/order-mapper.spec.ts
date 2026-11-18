import { describe, expect, it } from 'vitest';
import { mapWebhookOrder, WebhookOrderPayload } from './order-mapper.js';

const payload: WebhookOrderPayload = {
  id: 1001,
  admin_graphql_api_id: 'gid://shopify/Order/1001',
  name: '#1001',
  created_at: '2026-11-17T10:30:00Z',
  updated_at: '2026-11-17T11:00:00Z',
  currency: 'USD',
  email: null,
  financial_status: 'paid',
  fulfillment_status: null,
  subtotal_price: '40.00',
  total_price: '42.50',
  customer: null,
  line_items: [{ id: 5, variant_id: 9, title: 'Mug', sku: 'MUG-1', quantity: 2, price: '20.00' }],
};

describe('mapWebhookOrder', () => {
  it('keeps the Shopify GID as the order identifier', () => {
    expect(mapWebhookOrder(payload).shopifyOrderId).toBe('gid://shopify/Order/1001');
  });

  it('stores money as exact decimals', () => {
    const order = mapWebhookOrder(payload);
    expect(order.totalPrice.toFixed(2)).toBe('42.50');
    expect(order.items[0].lineTotal.toFixed(2)).toBe('40.00');
  });

  it('normalises statuses and treats a missing fulfillment status as unfulfilled', () => {
    const order = mapWebhookOrder(payload);
    expect(order.financialStatus).toBe('PAID');
    expect(order.fulfillmentStatus).toBe('UNFULFILLED');
  });

  it('keeps guest orders searchable without creating a customer', () => {
    const order = mapWebhookOrder({ ...payload, email: 'guest@example.com' });
    expect(order.customer).toBeNull();
    expect(order.customerEmail).toBe('guest@example.com');
  });

  it('builds the customer name from the linked customer', () => {
    const order = mapWebhookOrder({
      ...payload,
      customer: { id: 77, email: 'ann@example.com', first_name: 'Ann', last_name: 'Lee', phone: null },
    });
    expect(order.customerName).toBe('Ann Lee');
    expect(order.customer?.shopifyCustomerId).toBe('gid://shopify/Customer/77');
  });
});
