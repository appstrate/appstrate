# PayPal API

Base URL: `https://api-m.paypal.com`

Online payment processing API. Create orders, capture payments, issue refunds, manage invoices, and search transactions. Uses `client_secret_basic` (HTTP Basic Auth) for token exchange. Sandbox available at `api-m.sandbox.paypal.com`.

## Endpoints

### Get User Info
`GET /v1/identity/openidconnect/userinfo?schema=openid`

Returns the authenticated user's profile. Requires `openid` scope.

**Response:**
```json
{
  "user_id": "https://www.paypal.com/webapps/auth/identity/user/abc123",
  "name": "John Doe",
  "email": "john@example.com",
  "verified": true,
  "address": {
    "street_address": "123 Main St",
    "locality": "Paris",
    "country": "FR"
  }
}
```

### Create Order
`POST /v2/checkout/orders`

Creates a new payment order. Requires `https://uri.paypal.com/services/payments/payment` scope.

**Request body (JSON):**
```json
{
  "intent": "CAPTURE",
  "purchase_units": [
    {
      "reference_id": "order_001",
      "amount": {
        "currency_code": "EUR",
        "value": "99.99",
        "breakdown": {
          "item_total": { "currency_code": "EUR", "value": "89.99" },
          "shipping": { "currency_code": "EUR", "value": "10.00" }
        }
      },
      "items": [
        {
          "name": "Widget Pro",
          "quantity": "1",
          "unit_amount": { "currency_code": "EUR", "value": "89.99" },
          "category": "PHYSICAL_GOODS"
        }
      ]
    }
  ],
  "application_context": {
    "return_url": "https://example.com/return",
    "cancel_url": "https://example.com/cancel"
  }
}
```

**Response:**
```json
{
  "id": "5O190127TN364715T",
  "status": "CREATED",
  "links": [
    {
      "href": "https://api-m.paypal.com/v2/checkout/orders/5O190127TN364715T",
      "rel": "self",
      "method": "GET"
    },
    {
      "href": "https://www.paypal.com/checkoutnow?token=5O190127TN364715T",
      "rel": "approve",
      "method": "GET"
    }
  ]
}
```

### Get Order
`GET /v2/checkout/orders/{orderId}`

Returns order details.

**Response:**
```json
{
  "id": "5O190127TN364715T",
  "status": "APPROVED",
  "intent": "CAPTURE",
  "purchase_units": [
    {
      "reference_id": "order_001",
      "amount": { "currency_code": "EUR", "value": "99.99" },
      "payee": { "email_address": "merchant@example.com" }
    }
  ],
  "payer": {
    "name": { "given_name": "Alice", "surname": "Martin" },
    "email_address": "alice@example.com",
    "payer_id": "BUYER123"
  }
}
```

### Capture Order
`POST /v2/checkout/orders/{orderId}/capture`

Captures payment for an approved order. Requires `https://uri.paypal.com/services/payments/payment` scope.

**Response:**
```json
{
  "id": "5O190127TN364715T",
  "status": "COMPLETED",
  "purchase_units": [
    {
      "payments": {
        "captures": [
          {
            "id": "3C679366HH908993F",
            "status": "COMPLETED",
            "amount": { "currency_code": "EUR", "value": "99.99" },
            "create_time": "2024-06-15T10:30:00Z"
          }
        ]
      }
    }
  ]
}
```

### Refund Capture
`POST /v2/payments/captures/{captureId}/refund`

Issues a refund. Requires `https://uri.paypal.com/services/payments/refund` scope.

**Request body (JSON):**
```json
{
  "amount": {
    "currency_code": "EUR",
    "value": "50.00"
  },
  "note_to_payer": "Partial refund for returned item"
}
```

### Search Transactions
`GET /v1/reporting/transactions`

Searches transaction history. Requires `https://uri.paypal.com/services/reporting/search/read` scope.

**Query parameters:**
- `start_date` — Start date (ISO 8601, required)
- `end_date` — End date (ISO 8601, required)
- `transaction_status` — Filter: `D` (denied), `P` (pending), `S` (successful), `V` (reversed)
- `page` — Page number (1-indexed)
- `page_size` — Items per page (default 100, max 500)

**Response:**
```json
{
  "transaction_details": [
    {
      "transaction_info": {
        "transaction_id": "3C679366HH908993F",
        "transaction_event_code": "T0006",
        "transaction_amount": { "currency_code": "EUR", "value": "99.99" },
        "transaction_status": "S",
        "transaction_updated_date": "2024-06-15T10:30:00+0000"
      },
      "payer_info": {
        "payer_name": { "given_name": "Alice", "surname": "Martin" },
        "email_address": "alice@example.com"
      }
    }
  ],
  "total_items": 42,
  "total_pages": 1
}
```

### Create Invoice
`POST /v2/invoicing/invoices`

Creates a draft invoice. Requires `https://uri.paypal.com/services/invoicing` scope.

**Request body (JSON):**
```json
{
  "detail": {
    "currency_code": "EUR",
    "invoice_date": "2024-06-15",
    "payment_term": {
      "term_type": "NET_30"
    }
  },
  "invoicer": {
    "name": { "given_name": "John", "surname": "Doe" },
    "email_address": "john@example.com"
  },
  "primary_recipients": [
    {
      "billing_info": {
        "name": { "given_name": "Alice", "surname": "Martin" },
        "email_address": "alice@example.com"
      }
    }
  ],
  "items": [
    {
      "name": "Consulting",
      "quantity": "10",
      "unit_amount": { "currency_code": "EUR", "value": "150.00" },
      "unit_of_measure": "HOURS"
    }
  ]
}
```

### Send Invoice
`POST /v2/invoicing/invoices/{invoiceId}/send`

Sends a draft invoice to the recipient.

**Request body (JSON):**
```json
{
  "send_to_invoicer": true,
  "send_to_recipient": true,
  "note": "Please review and pay the attached invoice."
}
```

### Get Subscription
`GET /v1/billing/subscriptions/{subscriptionId}`

Returns subscription details. Requires `https://uri.paypal.com/services/subscriptions` scope.

## Common Patterns

### Pagination
Page-based pagination:
- `page` (1-indexed) and `page_size` parameters
- Response includes `total_items` and `total_pages`
- Some endpoints use `links` array with `rel: "next"` for navigation

### HATEOAS Links
Most responses include a `links` array with related actions:
```json
{
  "links": [
    { "href": "...", "rel": "self", "method": "GET" },
    { "href": "...", "rel": "approve", "method": "GET" },
    { "href": "...", "rel": "capture", "method": "POST" }
  ]
}
```

### Error Format
```json
{
  "name": "RESOURCE_NOT_FOUND",
  "message": "The specified resource does not exist.",
  "debug_id": "abc123",
  "details": [
    {
      "issue": "INVALID_RESOURCE_ID",
      "description": "Specified resource ID does not exist."
    }
  ]
}
```

## Important Notes
- Uses `client_secret_basic` (HTTP Basic Auth) for token exchange.
- Access tokens expire after ~8 hours.
- PayPal uses URI-based scopes (e.g. `https://uri.paypal.com/services/payments/payment`).
- Order payment flow: Create order → Redirect buyer to approve → Capture payment.
- Amounts are strings, not numbers (e.g. `"99.99"` not `99.99`).
- Sandbox environment: replace `api-m.paypal.com` with `api-m.sandbox.paypal.com`.
- Transaction IDs are alphanumeric strings (17 characters).
- Rate limits vary by endpoint and account type.
- Date range for transaction search: max 31 days per request.
