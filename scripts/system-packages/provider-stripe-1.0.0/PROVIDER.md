# Stripe API

Base URL: `https://api.stripe.com/v1`

## Quick Reference

Payment processing API. Manage customers, charges, subscriptions, invoices, and payment intents.
All requests use form-encoded bodies (not JSON). All responses are JSON.

## Key Endpoints

### List Customers
GET /customers
List all customers.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/customers?limit=10" \
  -H "Authorization: Bearer {{api_key}}"
```

### Get Customer
GET /customers/{id}
Retrieve a specific customer.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/customers/{CUSTOMER_ID}" \
  -H "Authorization: Bearer {{api_key}}"
```

### Create Customer
POST /customers
Create a new customer.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/customers" \
  -H "Authorization: Bearer {{api_key}}" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "email=user@example.com&name=John%20Doe&description=New%20customer"
```

### List Charges
GET /charges
List all charges.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/charges?limit=10" \
  -H "Authorization: Bearer {{api_key}}"
```

### List Payment Intents
GET /payment_intents
List payment intents (recommended over charges for modern integrations).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/payment_intents?limit=10" \
  -H "Authorization: Bearer {{api_key}}"
```

### List Subscriptions
GET /subscriptions
List all subscriptions.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/subscriptions?limit=10&status=active" \
  -H "Authorization: Bearer {{api_key}}"
```

### List Invoices
GET /invoices
List all invoices.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/invoices?limit=10&customer={CUSTOMER_ID}" \
  -H "Authorization: Bearer {{api_key}}"
```

### Get Balance
GET /balance
Retrieve the current account balance.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/balance" \
  -H "Authorization: Bearer {{api_key}}"
```

### List Products
GET /products
List all products.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: stripe" \
  -H "X-Target: https://api.stripe.com/v1/products?limit=10&active=true" \
  -H "Authorization: Bearer {{api_key}}"
```

## Common Patterns

### Pagination
Cursor-based using `starting_after` and `ending_before` (object IDs).
Response includes `has_more: true` when more results exist.
Max `limit` is 100.

**Example:**
`/v1/customers?limit=10&starting_after=cus_abc123`

### Request Format
POST/PUT requests use **form-encoded** bodies (not JSON):
- Simple: `name=John&email=john@example.com`
- Nested: `metadata[key]=value`
- Arrays: `items[0][price]=price_123&items[0][quantity]=1`

### Expanding Objects
Use `expand[]` to include related objects inline:
`/v1/charges?expand[]=data.customer&expand[]=data.invoice`

### Filtering by Date
Use Unix timestamps with `created` parameter:
- `created[gte]=1704067200` -- created on or after Jan 1, 2024
- `created[lte]=1735689600` -- created on or before Dec 31, 2024

## Important Notes

- Stripe uses `sk_test_*` keys for test mode and `sk_live_*` for production. All data is isolated by mode.
- Amounts are in the smallest currency unit (e.g., cents for USD). `amount: 1000` = $10.00.
- Rate limit: 100 read requests/second, 100 write requests/second in live mode. Test mode: 25/s.
- All write operations are idempotent if you include `Idempotency-Key` header.
- Use Payment Intents API for new integrations (Charges API is legacy).
- Metadata: attach up to 50 key-value pairs to any object.