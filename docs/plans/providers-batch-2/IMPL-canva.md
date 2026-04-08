# IMPL: Canva Provider

## Provider Info
- **Slug**: `canva`
- **Display Name**: Canva
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.canva.com/rest/v1`
- **Docs**: https://www.canva.dev/docs/connect/

## Auth Details
- **Authorization URL**: `https://www.canva.com/api/oauth/authorize`
- **Token URL**: `https://api.canva.com/rest/v1/oauth/token`
- **Refresh URL**: `https://api.canva.com/rest/v1/oauth/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_basic`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `design:meta:read` — Read design metadata
  - `design:content:read` — Read design content
  - `profile:read` — Read user profile
- **Available**:
  - `design:meta:read` — Read design metadata
  - `design:content:read` — Read design content
  - `design:content:write` — Write design content
  - `design:permission:read` — Read design permissions
  - `design:permission:write` — Write design permissions
  - `folder:read` — Read folders
  - `folder:write` — Write folders
  - `asset:read` — Read assets
  - `asset:write` — Upload assets
  - `brandtemplate:meta:read` — Read brand templates
  - `brandtemplate:content:read` — Read brand template content
  - `profile:read` — Read user profile
  - `comment:read` — Read comments
  - `comment:write` — Write comments

## Authorized URIs
- `https://api.canva.com/*`

## Setup Guide
1. Create a Canva app → https://www.canva.com/developers/integrations
2. Configure OAuth redirect URI and scopes
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /v1/users/me — Get current user
2. GET /v1/designs — List designs
3. GET /v1/designs/{designId} — Get design metadata
4. POST /v1/designs — Create design
5. GET /v1/designs/{designId}/export — Export design
6. POST /v1/designs/{designId}/export — Start export job
7. GET /v1/folders — List folders
8. GET /v1/folders/{folderId}/items — List folder items
9. POST /v1/assets/upload — Upload asset
10. GET /v1/brand-templates — List brand templates
11. GET /v1/brand-templates/{id} — Get brand template

## Compatibility Notes
- Uses `client_secret_basic` for token exchange
- PKCE required
- Access tokens expire after 1 hour, refresh tokens after 6 months
- Export is async: POST to start, poll GET for result
- Design dimensions in pixels
- File uploads use multipart/form-data
- Rate limits: varies by endpoint
