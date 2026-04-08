# IMPL: Intercom Provider

## Provider Info
- **Slug**: `intercom`
- **Display Name**: Intercom
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.intercom.io`
- **Docs**: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/

## Auth Details
- **Authorization URL**: `https://app.intercom.com/oauth`
- **Token URL**: `https://api.intercom.io/auth/eagle/token`
- **Refresh URL**: none (Intercom tokens don't expire)
- **PKCE**: false
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- Intercom does NOT use granular OAuth scopes — access is controlled at the app level
- **Default Scopes**: [] (no scopes)
- **Available Scopes**: [] (none)

## Authorized URIs
- `https://api.intercom.io/*`

## Setup Guide
1. Create an Intercom developer app → https://app.intercom.com/a/apps/_/developer-hub
2. Configure OAuth redirect URI
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /me — Get current admin
2. GET /contacts — List contacts (customers/leads)
3. GET /contacts/{id} — Get contact
4. POST /contacts — Create contact
5. PUT /contacts/{id} — Update contact
6. DELETE /contacts/{id} — Delete contact
7. POST /contacts/search — Search contacts
8. GET /conversations — List conversations
9. GET /conversations/{id} — Get conversation
10. POST /conversations/{id}/reply — Reply to conversation
11. POST /messages — Send message
12. GET /tags — List tags

## Compatibility Notes
- **No refresh tokens** — Intercom access tokens don't expire (permanent)
- No `refreshUrl` needed
- API versioning via `Intercom-Version` header (e.g. `2.11`)
- Search endpoints use POST with query body (not GET with params)
- Pagination uses cursor-based `starting_after` parameter
- Rate limit: ~1000 API calls per minute per workspace
