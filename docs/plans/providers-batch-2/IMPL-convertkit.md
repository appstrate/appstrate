# IMPL: ConvertKit (Kit) Provider

## Provider Info
- **Slug**: `convertkit`
- **Display Name**: ConvertKit (Kit)
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.kit.com/v4`
- **Docs**: https://developers.kit.com/

## Auth Details
- **Authorization URL**: `https://app.kit.com/oauth/authorize`
- **Token URL**: `https://app.kit.com/oauth/token`
- **Refresh URL**: `https://app.kit.com/oauth/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- Kit (ConvertKit) does NOT use granular scopes — full access is granted
- **Default Scopes**: [] (no scopes)
- **Available Scopes**: [] (none)

## Authorized URIs
- `https://api.kit.com/*`

## Setup Guide
1. Create a Kit OAuth app → https://app.kit.com/account_settings/developer_settings
2. Configure redirect URI
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /v4/account — Get account info
2. GET /v4/subscribers — List subscribers
3. GET /v4/subscribers/{id} — Get subscriber
4. POST /v4/subscribers — Create subscriber
5. PUT /v4/subscribers/{id} — Update subscriber
6. GET /v4/forms — List forms
7. GET /v4/forms/{id}/subscribers — List form subscribers
8. POST /v4/forms/{id}/subscribers — Add subscriber to form
9. GET /v4/tags — List tags
10. POST /v4/tags/{id}/subscribers — Tag subscriber
11. GET /v4/sequences — List email sequences
12. GET /v4/broadcasts — List broadcasts

## Compatibility Notes
- ConvertKit rebranded to "Kit" — API is at `api.kit.com`
- V4 API uses JSON request/response bodies
- OAuth tokens include refresh capability
- Access tokens expire after 2 hours
- Pagination uses `page` and `per_page` parameters
- Subscriber identifiers: ID or email address
- Rate limit: 120 requests/minute
