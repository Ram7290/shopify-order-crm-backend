import { Prisma } from '../generated/prisma/client.js';

export interface NormalizedCustomer {
  shopifyCustomerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

export interface NormalizedLineItem {
  shopifyLineItemId: string;
  shopifyVariantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

export interface NormalizedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  customer: NormalizedCustomer | null;
  customerName: string | null;
  customerEmail: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string;
  subtotalPrice: Prisma.Decimal | null;
  totalPrice: Prisma.Decimal;
  orderDate: Date;
  shopifyUpdatedAt: Date;
  items: NormalizedLineItem[];
}

export interface GraphqlOrderNode {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  currencyCode: string;
  email: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  subtotalPriceSet: { shopMoney: { amount: string } } | null;
  totalPriceSet: { shopMoney: { amount: string } };
  customer: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
  } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      sku: string | null;
      quantity: number;
      variant: { id: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } };
    }[];
  };
}

export interface WebhookOrderPayload {
  id: number;
  admin_graphql_api_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  currency: string;
  email: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  subtotal_price: string | null;
  total_price: string;
  customer: {
    id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
  } | null;
  line_items: {
    id: number;
    variant_id: number | null;
    title: string;
    sku: string | null;
    quantity: number;
    price: string;
  }[];
}

export function mapGraphqlOrder(node: GraphqlOrderNode): NormalizedOrder {
  const customer = node.customer
    ? {
        shopifyCustomerId: node.customer.id,
        email: node.customer.email,
        firstName: node.customer.firstName,
        lastName: node.customer.lastName,
        phone: node.customer.phone,
      }
    : null;

  return {
    shopifyOrderId: node.id,
    orderNumber: node.name,
    customer,
    customerName: joinName(customer?.firstName, customer?.lastName),
    customerEmail: customer?.email ?? node.email,
    financialStatus: node.displayFinancialStatus,
    fulfillmentStatus: node.displayFulfillmentStatus,
    currency: node.currencyCode,
    subtotalPrice: node.subtotalPriceSet ? new Prisma.Decimal(node.subtotalPriceSet.shopMoney.amount) : null,
    totalPrice: new Prisma.Decimal(node.totalPriceSet.shopMoney.amount),
    orderDate: new Date(node.createdAt),
    shopifyUpdatedAt: new Date(node.updatedAt),
    items: node.lineItems.nodes.map((item) => {
      const unitPrice = new Prisma.Decimal(item.originalUnitPriceSet.shopMoney.amount);
      return {
        shopifyLineItemId: item.id,
        shopifyVariantId: item.variant?.id ?? null,
        title: item.title,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice,
        lineTotal: unitPrice.mul(item.quantity),
      };
    }),
  };
}

export function mapWebhookOrder(payload: WebhookOrderPayload): NormalizedOrder {
  const customer = payload.customer
    ? {
        shopifyCustomerId: `gid://shopify/Customer/${payload.customer.id}`,
        email: payload.customer.email,
        firstName: payload.customer.first_name,
        lastName: payload.customer.last_name,
        phone: payload.customer.phone,
      }
    : null;

  return {
    shopifyOrderId: payload.admin_graphql_api_id,
    orderNumber: payload.name,
    customer,
    customerName: joinName(customer?.firstName, customer?.lastName),
    customerEmail: customer?.email ?? payload.email,
    financialStatus: payload.financial_status?.toUpperCase() ?? null,
    fulfillmentStatus: payload.fulfillment_status?.toUpperCase() ?? 'UNFULFILLED',
    currency: payload.currency,
    subtotalPrice: payload.subtotal_price ? new Prisma.Decimal(payload.subtotal_price) : null,
    totalPrice: new Prisma.Decimal(payload.total_price),
    orderDate: new Date(payload.created_at),
    shopifyUpdatedAt: new Date(payload.updated_at),
    items: payload.line_items.map((item) => {
      const unitPrice = new Prisma.Decimal(item.price);
      return {
        shopifyLineItemId: `gid://shopify/LineItem/${item.id}`,
        shopifyVariantId: item.variant_id ? `gid://shopify/ProductVariant/${item.variant_id}` : null,
        title: item.title,
        sku: item.sku,
        quantity: item.quantity,
        unitPrice,
        lineTotal: unitPrice.mul(item.quantity),
      };
    }),
  };
}

function joinName(firstName?: string | null, lastName?: string | null): string | null {
  const name = [firstName, lastName].filter(Boolean).join(' ');
  return name || null;
}
