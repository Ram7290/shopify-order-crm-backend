export const ORDER_FIELDS_FRAGMENT = `
fragment OrderFields on Order {
  id
  name
  createdAt
  updatedAt
  currencyCode
  email
  displayFinancialStatus
  displayFulfillmentStatus
  subtotalPriceSet { shopMoney { amount } }
  totalPriceSet { shopMoney { amount } }
  customer { id email firstName lastName phone }
  lineItems(first: 100) {
    nodes {
      id
      title
      sku
      quantity
      variant { id }
      originalUnitPriceSet { shopMoney { amount } }
    }
  }
}
`;

export const ORDERS_PAGE_QUERY = `
query OrdersPage($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes { ...OrderFields }
  }
}
${ORDER_FIELDS_FRAGMENT}
`;

export const PRODUCT_SEARCH_QUERY = `
query ProductSearch($first: Int!, $query: String) {
  products(first: $first, query: $query) {
    nodes {
      title
      variants(first: 20) {
        nodes { id title sku price }
      }
    }
  }
}
`;

export const WEBHOOK_SUBSCRIPTION_CREATE_MUTATION = `
mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id }
    userErrors { field message }
  }
}
`;

export const DRAFT_ORDER_CREATE_MUTATION = `
mutation DraftOrderCreate($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder { id }
    userErrors { field message }
  }
}
`;

export const DRAFT_ORDER_COMPLETE_MUTATION = `
mutation DraftOrderComplete($id: ID!) {
  draftOrderComplete(id: $id, paymentPending: true) {
    draftOrder { order { ...OrderFields } }
    userErrors { field message }
  }
}
${ORDER_FIELDS_FRAGMENT}
`;
