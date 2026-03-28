# Stripe API

Base URL: `https://api.stripe.com/v1`

Payment processing API. Manage customers, charges, subscriptions, invoices, and payment intents. All requests use **form-encoded** bodies (not JSON). All responses are JSON.

## Endpoints

### List Customers
`GET /customers`

**Query parameters:**
- `limit` — Max results (1-100, default 10)
- `starting_after` — Cursor for next page (customer ID)
- `ending_before` — Cursor for previous page (customer ID)
- `email` — Filter by exact email
- `created[gte]` / `created[lte]` — Filter by creation date (Unix timestamp)

**Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "cus_abc123", "object": "customer", "email": "user@example.com", "name": "John Doe", "created": 1704067200 }
  ],
  "has_more": true,
  "url": "/v1/customers"
}
```

### Get Customer
`GET /customers/{CUSTOMER_ID}`

Retrieve a specific customer.

### Create Customer
`POST /customers`

**Request body (form-encoded):**
- `email` — Customer email
- `name` — Customer name
- `description` — Description
- `metadata[key]` — Metadata key-value pairs

### Update Customer
`POST /customers/{CUSTOMER_ID}`

**Request body (form-encoded):** Same fields as Create.

### Delete Customer
`DELETE /customers/{CUSTOMER_ID}`

### List Payment Intents
`GET /payment_intents`

List payment intents (recommended over charges for modern integrations).

**Query parameters:**
- `limit` — Max results (1-100)
- `starting_after` / `ending_before` — Pagination cursors
- `customer` — Filter by customer ID
- `created[gte]` / `created[lte]` — Date range (Unix timestamp)

### Get Payment Intent
`GET /payment_intents/{PAYMENT_INTENT_ID}`

### Create Payment Intent
`POST /payment_intents`

**Request body (form-encoded):**
- `amount` — Amount in smallest currency unit (e.g. cents)
- `currency` — Three-letter ISO currency code (e.g. `usd`)
- `customer` — Customer ID
- `description` — Description
- `metadata[key]` — Metadata

### List Charges
`GET /charges`

**Query parameters:** Same pattern as other list endpoints (`limit`, `starting_after`, `customer`, `created`).

### Get Charge
`GET /charges/{CHARGE_ID}`

### List Subscriptions
`GET /subscriptions`

**Query parameters:**
- `limit` — Max results (1-100)
- `starting_after` / `ending_before` — Pagination cursors
- `customer` — Filter by customer ID
- `status` — Filter by status (`active`, `past_due`, `canceled`, `unpaid`, `trialing`, `all`)
- `price` — Filter by price ID

### Get Subscription
`GET /subscriptions/{SUBSCRIPTION_ID}`

### Create Subscription
`POST /subscriptions`

**Request body (form-encoded):**
- `customer` — Customer ID (required)
- `items[0][price]` — Price ID
- `items[0][quantity]` — Quantity

### Cancel Subscription
`DELETE /subscriptions/{SUBSCRIPTION_ID}`

### List Invoices
`GET /invoices`

**Query parameters:**
- `limit` — Max results (1-100)
- `customer` — Filter by customer ID
- `status` — Filter by status (`draft`, `open`, `paid`, `uncollectible`, `void`)
- `subscription` — Filter by subscription ID

### Get Invoice
`GET /invoices/{INVOICE_ID}`

### Get Balance
`GET /balance`

Retrieve the current account balance.

**Response:**
```json
{
  "object": "balance",
  "available": [{ "amount": 50000, "currency": "usd" }],
  "pending": [{ "amount": 1000, "currency": "usd" }]
}
```

### List Products
`GET /products`

**Query parameters:**
- `limit` — Max results (1-100)
- `active` — Filter by active status (`true`/`false`)

### Get Product
`GET /products/{PRODUCT_ID}`

### List Prices
`GET /prices`

**Query parameters:**
- `limit` — Max results (1-100)
- `product` — Filter by product ID
- `active` — Filter by active status
- `type` — Filter by type (`one_time`, `recurring`)

## Common Patterns

### Pagination
Cursor-based using `starting_after` and `ending_before` (object IDs). Response includes `has_more: true` when more results exist. Max `limit` is 100.

Example: `/v1/customers?limit=10&starting_after=cus_abc123`

### Request Format
POST/PUT requests use **form-encoded** bodies (not JSON):
- Simple: `name=John&email=john@example.com`
- Nested objects: `metadata[key]=value`
- Arrays: `items[0][price]=price_123&items[0][quantity]=1`

### Expanding Objects
Use `expand[]` to include related objects inline instead of just their IDs:
- `/v1/charges?expand[]=data.customer`
- `/v1/invoices/{ID}?expand[]=subscription&expand[]=customer`

### Filtering by Date
Use Unix timestamps with the `created` parameter:
- `created[gte]=1704067200` — created on or after Jan 1, 2024
- `created[lte]=1735689600` — created on or before Dec 31, 2024
- `created[gt]` and `created[lt]` for exclusive ranges

## Important Notes

- Amounts are in the **smallest currency unit** (e.g. cents for USD). `amount: 1000` = $10.00. Some currencies (JPY, KRW, etc.) don't use subunits — `amount: 1000` in JPY means ¥1000, not ¥10.
- Stripe uses `sk_test_*` keys for test mode and `sk_live_*` for production. All data is isolated by mode.
- Rate limit: 25 requests/second (default, both live and test modes). Higher limits for Connect platforms. Some endpoints have lower limits (Search: 20/s, Files: 20/s).
- All write operations are idempotent if you include an `Idempotency-Key` header.
- Use Payment Intents API for new integrations (Charges API is legacy).
- Metadata: attach up to 50 key-value pairs (max 40 char keys, 500 char values) to any object.
- All list endpoints return the same structure: `{ object: "list", data: [...], has_more, url }`.
