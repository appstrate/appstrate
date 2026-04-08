# IMPL: Mailchimp Provider

## Provider Info
- **Slug**: `mailchimp`
- **Display Name**: Mailchimp
- **Auth Mode**: OAuth2
- **Base URL**: `https://{dc}.api.mailchimp.com/3.0` (dc = data center from metadata endpoint)
- **Docs**: https://mailchimp.com/developer/marketing/api/

## Auth Details
- **Authorization URL**: `https://login.mailchimp.com/oauth2/authorize`
- **Token URL**: `https://login.mailchimp.com/oauth2/token`
- **Refresh URL**: none (Mailchimp tokens don't expire)
- **PKCE**: false
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- Mailchimp does NOT use granular scopes — the OAuth token grants full access to the account.
- **Default Scopes**: [] (no scopes needed)
- **Available Scopes**: [] (none)

## Authorized URIs
- `https://*.api.mailchimp.com/*`
- `https://login.mailchimp.com/*`

## Setup Guide
1. Register your app → https://admin.mailchimp.com/account/oauth2/
2. Set the redirect URI
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /3.0/ — API root (account info + data center)
2. GET /3.0/lists — List audiences
3. GET /3.0/lists/{list_id}/members — List members of audience
4. POST /3.0/lists/{list_id}/members — Add member to audience
5. PATCH /3.0/lists/{list_id}/members/{subscriber_hash} — Update member
6. DELETE /3.0/lists/{list_id}/members/{subscriber_hash} — Archive member
7. GET /3.0/campaigns — List campaigns
8. POST /3.0/campaigns — Create campaign
9. GET /3.0/campaigns/{campaign_id} — Get campaign
10. POST /3.0/campaigns/{campaign_id}/actions/send — Send campaign
11. GET /3.0/reports/{campaign_id} — Get campaign report

## Compatibility Notes
- **No refresh tokens** — Mailchimp access tokens don't expire (permanent tokens)
- No `refreshUrl` needed
- Data center (dc) must be discovered via metadata endpoint or from token response
- Agent must call `https://login.mailchimp.com/oauth2/metadata` with Bearer token to get `dc` and `api_endpoint`
- subscriber_hash = MD5 hash of lowercase email address
