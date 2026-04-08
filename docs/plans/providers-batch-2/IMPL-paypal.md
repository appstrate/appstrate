# IMPL: PayPal Provider

## Provider Info
- **Slug**: `paypal`
- **Display Name**: PayPal
- **Auth Mode**: OAuth2
- **Base URL**: `https://api-m.paypal.com`
- **Docs**: https://developer.paypal.com/docs/api/overview/

## Auth Details
- **Authorization URL**: `https://www.paypal.com/signin/authorize`
- **Token URL**: `https://api-m.paypal.com/v1/oauth2/token`
- **Refresh URL**: `https://api-m.paypal.com/v1/oauth2/token`
- **PKCE**: false
- **Token Auth Method**: `client_secret_basic`
- **Scope Separator**: space
- **Token Params**: `{ "grant_type": "authorization_code" }`

## Scopes
- **Default (read-only)**:
  - `openid` — OpenID Connect
  - `email` — Email address
  - `profile` — Basic profile
- **Available**:
  - `openid` — OpenID Connect
  - `email` — Email address
  - `profile` — Basic profile
  - `https://uri.paypal.com/services/payments/payment` — Accept payments
  - `https://uri.paypal.com/services/payments/refund` — Issue refunds
  - `https://uri.paypal.com/services/reporting/search/read` — Transaction search
  - `https://uri.paypal.com/services/invoicing` — Invoicing
  - `https://uri.paypal.com/services/subscriptions` — Subscriptions

## Authorized URIs
- `https://api-m.paypal.com/*`
- `https://api-m.sandbox.paypal.com/*`

## Setup Guide
1. Create a PayPal app → https://developer.paypal.com/dashboard/applications/live
2. Configure return URL
3. Copy Client ID and Secret

## Key Endpoints to Document
1. GET /v1/identity/openidconnect/userinfo?schema=openid — Get user info
2. POST /v2/checkout/orders — Create order
3. GET /v2/checkout/orders/{id} — Get order details
4. POST /v2/checkout/orders/{id}/capture — Capture payment
5. POST /v2/payments/captures/{id}/refund — Refund capture
6. GET /v1/reporting/transactions — Search transactions
7. POST /v2/invoicing/invoices — Create invoice
8. GET /v2/invoicing/invoices/{id} — Get invoice
9. POST /v2/invoicing/invoices/{id}/send — Send invoice
10. GET /v1/billing/subscriptions/{id} — Get subscription

## Compatibility Notes
- Uses `client_secret_basic` for token exchange
- Sandbox environment: `api-m.sandbox.paypal.com`
- Access tokens expire after ~8 hours
- PayPal uses its own URI-based scope format
- Most payment flows require buyer approval (redirects)
- Transaction IDs are alphanumeric strings
- Rate limits: varies by endpoint, documented per-API
