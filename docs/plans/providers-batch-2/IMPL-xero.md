# IMPL: Xero Provider

## Provider Info
- **Slug**: `xero`
- **Display Name**: Xero
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.xero.com/api.xro/2.0`
- **Docs**: https://developer.xero.com/documentation/api/accounting/overview

## Auth Details
- **Authorization URL**: `https://login.xero.com/identity/connect/authorize`
- **Token URL**: `https://identity.xero.com/connect/token`
- **Refresh URL**: `https://identity.xero.com/connect/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_basic`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `openid` — OpenID Connect
  - `profile` — User profile
  - `email` — User email
  - `accounting.transactions.read` — Read transactions
  - `accounting.contacts.read` — Read contacts
  - `offline_access` — Refresh tokens
- **Available**:
  - `accounting.transactions` — Read/write transactions
  - `accounting.transactions.read` — Read transactions
  - `accounting.contacts` — Read/write contacts
  - `accounting.contacts.read` — Read contacts
  - `accounting.settings` — Read/write settings
  - `accounting.settings.read` — Read settings
  - `accounting.reports.read` — Read reports
  - `accounting.journals.read` — Read journals
  - `accounting.attachments` — Read/write attachments
  - `offline_access` — Refresh tokens

## Authorized URIs
- `https://api.xero.com/*`

## Setup Guide
1. Create a Xero app → https://developer.xero.com/app/manage
2. Select Web App type, configure redirect URI
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /api.xro/2.0/Organisation — Get organisation info
2. GET /api.xro/2.0/Contacts — List contacts
3. GET /api.xro/2.0/Contacts/{ContactID} — Get contact
4. POST /api.xro/2.0/Contacts — Create/update contacts
5. GET /api.xro/2.0/Invoices — List invoices
6. GET /api.xro/2.0/Invoices/{InvoiceID} — Get invoice
7. POST /api.xro/2.0/Invoices — Create invoice
8. GET /api.xro/2.0/Accounts — List chart of accounts
9. GET /api.xro/2.0/BankTransactions — List bank transactions
10. GET /api.xro/2.0/Payments — List payments
11. GET /connections — List tenant connections

## Compatibility Notes
- Uses `client_secret_basic` for token exchange
- **Multi-tenant**: After auth, call `GET https://api.xero.com/connections` to get tenant IDs
- All API calls require `xero-tenant-id` header
- Access tokens expire after 30 minutes, refresh tokens after 60 days
- `offline_access` scope required for refresh tokens
- Supports `If-Modified-Since` header for conditional requests
- Pagination uses `page` parameter (100 items per page)
