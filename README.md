# shopify-order-crm-backend

NestJS API for the Mini Order Management CRM. It connects to a Shopify store through the Admin API, imports orders into PostgreSQL, creates orders in Shopify, and keeps orders in sync through webhooks.

- **Framework:** NestJS 12 (TypeScript, ESM)
- **Database:** PostgreSQL, accessed with Prisma 7 and the `@prisma/adapter-pg` driver
- **Shopify API:** GraphQL Admin API, version `2026-10`
- **Tests:** Vitest unit tests

## Features

- CRM login with JWT (passwords hashed with `scrypt`)
- Shopify OAuth install. The access token and refresh token are encrypted at rest (AES-256-GCM)
- Automatic refresh of expiring Shopify access tokens
- Order import from Shopify with paging, retry on rate limits and network errors
- Order list with server-side search (order number and customer name), status and date filters, sorting by date or total, and pagination
- Order details with line items
- Create an order in Shopify from the CRM. The local record is saved only after Shopify confirms it
- Webhooks for `orders/create` and `orders/updated`: HMAC-SHA256 verification on the raw body, deduplication by `X-Shopify-Webhook-Id`, stale-update protection by `updated_at`, and failure recording

## Project structure

```
src/
  app.module.ts          root module
  main.ts                bootstrap (raw body, validation, CORS, /api prefix)
  auth/                  login, JWT guard, password hashing
  common/                token encryption helpers
  orders/                list/detail/create, Shopify import, persistence, mapping
  prisma/                Prisma client provider
  shopify/               OAuth install, token storage, GraphQL client, HMAC helpers
  webhooks/              webhook endpoint, verification, deduplication
prisma/
  schema.prisma          data model
  migrations/            SQL migrations
```

## Data model

| Table | Purpose |
| --- | --- |
| `User` | CRM login accounts |
| `Shop` | Connected Shopify store, encrypted access and refresh tokens, granted scopes |
| `Customer` | Shopify customers, unique per shop by `shopifyCustomerId` |
| `Order` | Orders, unique per shop by `shopifyOrderId`. Has the list and search indexes |
| `OrderItem` | Line items of an order, cascade-deleted with the order |
| `WebhookEvent` | One row per webhook delivery. Unique per shop by `eventId` (`X-Shopify-Webhook-Id`). Holds status and errors |

Shopify IDs are stored as global IDs (for example `gid://shopify/Order/123`). Webhook payloads are converted to the same format, so an order is matched the same way whether it came from a sync, a webhook, or the CRM. Money uses `Decimal(12,2)`, never floats. Guest orders keep the customer name and email on the order itself, so they can still be searched.

## Local setup

Prerequisites: Node.js 22 or newer, PostgreSQL 14 or newer, and a Shopify app with a development store.

```bash
npm install
cp .env.example .env        # then fill in the values
npx prisma migrate dev      # creates the database tables
npm run start:dev           # http://localhost:3000/api
```

To receive real Shopify webhooks on your machine, expose the server over HTTPS (for example with `ngrok http 3000`) and set `SHOPIFY_APP_URL` to that address. Shopify cannot deliver webhooks to `localhost`.

## Environment variables

| Name | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string. Add `?sslmode=require` for Neon |
| `FRONTEND_URL` | Frontend origin, used for CORS and the post-install redirect |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First CRM login, created on startup if missing |
| `JWT_SECRET` | Secret for signing login tokens |
| `TOKEN_ENCRYPTION_KEY` | 64 hex characters (32 bytes). Encrypts Shopify tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SHOPIFY_API_KEY` | App client ID from the Dev Dashboard |
| `SHOPIFY_API_SECRET` | App client secret. Also used to verify webhooks |
| `SHOPIFY_SCOPES` | Scopes requested at install (see below) |
| `SHOPIFY_API_VERSION` | Admin API version, `2026-10` |
| `SHOPIFY_APP_URL` | Public HTTPS URL of this backend |

## Shopify app setup

1. In the Dev Dashboard, create an app named **Order CRM** and choose the manual option (not a template).
2. Set **App URL** to the backend URL (for example `https://your-backend.onrender.com`).
3. Set the **Redirect URL** to `<SHOPIFY_APP_URL>/api/shopify/callback`.
4. Keep **Embed app in Shopify admin** unchecked. The app is a standalone backend.
5. Set the access scopes to the list below and release a version.
6. Copy the client ID and secret into the environment variables.
7. Install the app on a development store by opening `<SHOPIFY_APP_URL>/api/shopify/install?shop=<store>.myshopify.com`.

Installing the app registers the `orders/create` and `orders/updated` webhooks automatically, pointing at `<SHOPIFY_APP_URL>/api/webhooks/shopify`.

### Required scopes

| Scope | Why it's needed |
| --- | --- |
| `read_orders` | Import orders and read order updates |
| `write_orders` | Required by the order creation flow |
| `write_draft_orders` | Creates a draft order and completes it (`draftOrderCreate`, `draftOrderComplete`) |
| `read_customers` | Reads customer name and email on orders |
| `read_products` | Reads product variants used when creating an order |

`read_all_orders` is needed only to import orders older than 60 days. It needs special access from Shopify, so it isn't requested here.

If you change the scopes, release a new app version and install the app again so the store grants the new permissions.

## Order creation approach

`POST /api/orders` runs two Admin API mutations:

1. `draftOrderCreate` with the customer's billing details and the variant IDs.
2. `draftOrderComplete` with `paymentPending: true`, which turns the draft into an order.

The CRM saves the order only after both steps succeed. If Shopify returns an error, the request fails and nothing is saved locally.

**Duplicate protection.** Every create request must send an `Idempotency-Key` header (8–100 letters, digits or dashes). The frontend creates one key per form and reuses it on retries.

- The key is recorded in the `OrderCreateRequest` table before Shopify is called, with a status of `PENDING`, `SUCCEEDED` or `FAILED`.
- The draft order is tagged `crm-request:<key>`.
- A repeated key that already succeeded returns the existing order without calling Shopify again.
- A repeated key while the first attempt is still running (within 30 seconds) returns `409 Conflict`.
- A repeated key after an unclear failure first searches Shopify for an order with that tag. If one exists, it is saved locally. If not, the order is created.
- A definite Shopify rejection marks the key `FAILED`, so the same key can be retried.

Limitations:
- Only existing product variants can be added. Custom line items are not supported.
- Orders are created with payment pending, so no payment is taken.
- If step 2 fails after step 1 succeeds, Shopify keeps an unused draft. It doesn't appear in the CRM.
- The tag search relies on Shopify copying draft order tags to the completed order. Confirm this on a development store before relying on it in production.

## Webhooks

| Topic | Handler |
| --- | --- |
| `orders/create` | Upserts the order, the customer, and the line items |
| `orders/updated` | Same upsert. Ignored if the stored `updated_at` is newer |

Flow for `POST /api/webhooks/shopify`:

1. Verify `X-Shopify-Hmac-Sha256` against the raw body with the app secret. Invalid signatures get **401** and nothing is written.
2. Look up the shop from `X-Shopify-Shop-Domain`.
3. Insert a `WebhookEvent` keyed by `X-Shopify-Webhook-Id`. If the event was already processed, return `{"status":"duplicate"}`.
4. Process the payload in a database transaction.
5. Mark the event `PROCESSED`. On failure, mark it `FAILED`, store the error, and return **500** so Shopify retries.

Failed events can be retried by Shopify, or reprocessed by re-sending the delivery. Processing is idempotent, so reprocessing is safe.

## API endpoints

All routes are under `/api`. Routes marked 🔒 need `Authorization: Bearer <token>`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | Health check |
| POST | `/auth/login` | Log in, returns a JWT |
| GET | `/shopify/install?shop=` | Start the OAuth install |
| GET | `/shopify/callback` | OAuth callback (called by Shopify) |
| GET 🔒 | `/shopify/status` | Connection status |
| GET 🔒 | `/orders` | List orders. Query: `page`, `pageSize` (max 100), `search`, `status`, `startDate`, `endDate` (YYYY-MM-DD), `sortBy` (`orderDate` or `totalPrice`), `sortOrder` (`asc` or `desc`) |
| GET 🔒 | `/orders/:id` | Order details with line items |
| POST 🔒 | `/orders` | Create an order in Shopify |
| POST 🔒 | `/orders/sync` | Import all orders from Shopify |
| POST | `/webhooks/shopify` | Shopify webhook receiver |

## Tests

### Unit tests

```bash
npm test          # 23 unit tests: HMAC checks, token encryption, password hashing,
                  # webhook mapping, duplicate-request decisions
npx tsc --noEmit  # type check
```

### End-to-end tests

The end-to-end script runs against a running backend, either local or deployed. It checks login, the order list (paging, search, filters, sorting, validation), order details, webhooks (forged and wrong signatures, duplicates, stale and newer updates), and order creation with duplicate protection.

1. Start the backend (`npm run start:dev`), or use the deployed URL.
2. Set the environment variables and run the script:

```bash
E2E_BASE_URL=http://localhost:3000/api \
ADMIN_EMAIL=admin@example.com \
ADMIN_PASSWORD='your-admin-password' \
SHOPIFY_API_SECRET='your-app-secret' \
SHOP_DOMAIN=your-store.myshopify.com \
npm run test:e2e
```

Options:

| Variable | Effect |
| --- | --- |
| `E2E_VARIANT_ID` | Enables the create-order checks. These create a **real order** in the connected Shopify store |
| `E2E_SKIP_SHOPIFY=1` | Skips the checks that call Shopify (sync and create). Use this when Shopify isn't reachable |
| `E2E_RATE_LIMIT=1` | Checks login rate limiting. This blocks login from that address for 15 minutes |

The script exits with code 1 if any check fails.

The webhook checks write test rows with order numbers starting `#E2E-`. Remove them with:

```sql
DELETE FROM "Order" WHERE "orderNumber" LIKE '#E2E-%';
DELETE FROM "WebhookEvent" WHERE "eventId" LIKE 'e2e-%';
```

## Security measures

- **Login rate limiting:** 5 login attempts per IP address per 15 minutes. Further attempts return HTTP 429.
- **General rate limiting:** 300 requests per IP address per minute across the API. Shopify webhooks are excluded, so deliveries are never blocked.
- **Trusted proxy:** the app trusts the first proxy hop, so the client IP is correct behind Render's load balancer.
- **Password hashing:** `scrypt` with a random salt per user.
- **Token encryption:** Shopify access and refresh tokens are encrypted with AES-256-GCM before they are stored.

## Deployment (Render + Neon)

1. **Database (Neon):** create a project and copy the connection string. Add `?sslmode=require` to the end.
2. **Backend (Render):** create a **Web Service** from this repository.
   - Runtime: Node
   - Build command: `npm install && npm run build`
   - Start command: `npm run start:prod` (runs `prisma migrate deploy`, then starts the server)
   - Set the environment variables from the table above. Set `FRONTEND_URL` to the Vercel URL and `SHOPIFY_APP_URL` to the Render URL.
3. Confirm `https://<your-backend>.onrender.com/api/health` returns `{"status":"ok"}`.
4. Update the Shopify app's **App URL** and **Redirect URL** to the Render URL, release a new version, and install the app again.
5. Test a real order change in Shopify and confirm the CRM updates.

Free Render services sleep after inactivity. The first request after a sleep can take up to a minute, and webhooks sent during the sleep may be retried by Shopify.
