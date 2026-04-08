# IMPL: Typeform Provider

## Provider Info
- **Slug**: `typeform`
- **Display Name**: Typeform
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.typeform.com`
- **Docs**: https://www.typeform.com/developers/

## Auth Details
- **Authorization URL**: `https://api.typeform.com/oauth/authorize`
- **Token URL**: `https://api.typeform.com/oauth/token`
- **Refresh URL**: `https://api.typeform.com/oauth/token`
- **PKCE**: false
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space (scopes use `+` in URL but space-separated in config)

## Scopes
- **Default (read-only)**:
  - `accounts:read` — Read account info
  - `forms:read` — Read forms
  - `responses:read` — Read responses
- **Available**:
  - `accounts:read` — Read account info
  - `forms:read` — Read forms
  - `forms:write` — Create and update forms
  - `responses:read` — Read form responses
  - `responses:write` — Delete form responses
  - `webhooks:read` — Read webhooks
  - `webhooks:write` — Create and update webhooks
  - `workspaces:read` — Read workspaces
  - `workspaces:write` — Create and update workspaces
  - `images:read` — Read images
  - `images:write` — Upload images
  - `themes:read` — Read themes
  - `themes:write` — Create and update themes
  - `offline:access` — Refresh tokens

## Authorized URIs
- `https://api.typeform.com/*`

## Setup Guide
1. Create a Typeform developer app → https://admin.typeform.com/account#/section/tokens
2. Configure OAuth redirect URI
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /me — Get current user info
2. GET /forms — List forms
3. GET /forms/{form_id} — Get form details
4. POST /forms — Create a form
5. PUT /forms/{form_id} — Update a form
6. DELETE /forms/{form_id} — Delete a form
7. GET /forms/{form_id}/responses — Get form responses
8. DELETE /forms/{form_id}/responses — Delete responses
9. GET /workspaces — List workspaces
10. GET /forms/{form_id}/webhooks — List webhooks

## Compatibility Notes
- `offline:access` scope required for refresh tokens
- Responses endpoint supports filtering by date, completion status
- Pagination uses `page_size` and `page` parameters (1-indexed)
