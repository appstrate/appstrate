# IMPL: Google Ads Provider

## Provider Info
- **Slug**: `google-ads`
- **Display Name**: Google Ads
- **Auth Mode**: OAuth2
- **Base URL**: `https://googleads.googleapis.com/v17`
- **Docs**: https://developers.google.com/google-ads/api/docs/start

## Auth Details
- **Authorization URL**: `https://accounts.google.com/o/oauth2/v2/auth`
- **Token URL**: `https://oauth2.googleapis.com/token`
- **Refresh URL**: `https://oauth2.googleapis.com/token`
- **PKCE**: false
- **Token Auth Method**: `client_secret_post`
- **Authorization Params**: `{ "access_type": "offline", "prompt": "consent" }`
- **Scope Separator**: space

## ⚠️ Compatibility Note
Google Ads API requires a **developer token** in addition to OAuth2 credentials. This must be sent as the `developer-token` header on every API request. The developer token is obtained via the Google Ads Manager Account and is NOT part of the OAuth flow.

**Recommendation**: Use a hybrid approach — OAuth2 for auth + a credential field for the developer token. Or document that the agent must include the developer token in requests.

## Scopes
- **Default (read-only)**:
  - `https://www.googleapis.com/auth/adwords` — Google Ads access (read/write, no read-only scope available)
- **Available**:
  - `https://www.googleapis.com/auth/adwords` — Full Google Ads access

## Authorized URIs
- `https://googleads.googleapis.com/*`

## Setup Guide
1. Create a Google Ads Manager Account → https://ads.google.com/home/tools/manager-accounts/
2. Apply for API access and get a developer token → https://developers.google.com/google-ads/api/docs/get-started/dev-token
3. Enable the Google Ads API → https://console.cloud.google.com/apis/library/googleads.googleapis.com
4. Create OAuth credentials → https://console.cloud.google.com/apis/credentials

## Key Endpoints to Document
1. POST /v17/customers/{customerId}/googleAds:searchStream — GAQL query (streaming)
2. POST /v17/customers/{customerId}/googleAds:search — GAQL query (paginated)
3. GET /v17/customers/{customerId} — Get customer info
4. POST /v17/customers/{customerId}/campaigns:mutate — Create/update campaigns
5. POST /v17/customers/{customerId}/adGroups:mutate — Create/update ad groups
6. POST /v17/customers/{customerId}/ads:mutate — Create/update ads
7. POST /v17/customers/{customerId}/keywords:mutate — Create/update keywords
8. GET /v17/customers:listAccessibleCustomers — List accessible customers

## Compatibility Notes
- **Developer token** required in `developer-token` header on ALL API requests
- Uses Google Ads Query Language (GAQL) for data retrieval
- API version in URL path (v17)
- Customer ID format: 10-digit number without hyphens
- Most operations use `:mutate` endpoints with operation arrays
- Supports `login-customer-id` header for MCC access
- Standard Google OAuth2 pattern for auth
