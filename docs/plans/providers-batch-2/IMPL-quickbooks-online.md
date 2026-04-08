# IMPL: QuickBooks Online Provider

## Provider Info
- **Slug**: `quickbooks-online`
- **Display Name**: QuickBooks Online
- **Auth Mode**: OAuth2
- **Base URL**: `https://quickbooks.api.intuit.com/v3`
- **Docs**: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities

## Auth Details
- **Authorization URL**: `https://appcenter.intuit.com/connect/oauth2`
- **Token URL**: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
- **Refresh URL**: `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`
- **PKCE**: false
- **Token Auth Method**: `client_secret_basic`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `com.intuit.quickbooks.accounting` — Read/write accounting data
- **Available**:
  - `com.intuit.quickbooks.accounting` — Accounting data (invoices, customers, etc.)
  - `com.intuit.quickbooks.payment` — Payment processing
  - `openid` — OpenID Connect
  - `profile` — User profile
  - `email` — User email

## Authorized URIs
- `https://quickbooks.api.intuit.com/*`
- `https://sandbox-quickbooks.api.intuit.com/*`

## Setup Guide
1. Create an Intuit developer app → https://developer.intuit.com/app/developer/dashboard
2. Configure OAuth redirect URIs in Keys & credentials
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /v3/company/{companyId}/query?query=SELECT * FROM Customer — Query customers
2. GET /v3/company/{companyId}/customer/{id} — Get customer
3. POST /v3/company/{companyId}/customer — Create customer
4. GET /v3/company/{companyId}/invoice/{id} — Get invoice
5. POST /v3/company/{companyId}/invoice — Create invoice
6. POST /v3/company/{companyId}/invoice/{id}?operation=void — Void invoice
7. GET /v3/company/{companyId}/companyinfo/{companyId} — Get company info
8. POST /v3/company/{companyId}/payment — Create payment
9. GET /v3/company/{companyId}/account/{id} — Get account
10. POST /v3/company/{companyId}/bill — Create bill

## Compatibility Notes
- Uses `client_secret_basic` (HTTP Basic Auth) for token exchange
- Access tokens expire after 1 hour, refresh tokens after 100 days
- Company ID (realm ID) is returned during OAuth flow, must be stored
- Uses SQL-like query language for list endpoints
- Minor version parameter recommended: `?minorversion=73`
- Sandbox environment available at `sandbox-quickbooks.api.intuit.com`
