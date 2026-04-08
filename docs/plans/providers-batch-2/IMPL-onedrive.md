# IMPL: OneDrive Provider

## Provider Info
- **Slug**: `onedrive`
- **Display Name**: OneDrive
- **Auth Mode**: OAuth2
- **Base URL**: `https://graph.microsoft.com/v1.0`
- **Docs**: https://learn.microsoft.com/en-us/graph/api/resources/onedrive

## Auth Details
- **Authorization URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- **Token URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- **Refresh URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `Files.Read` — Read user files
  - `User.Read` — Read user profile
  - `offline_access` — Refresh tokens
- **Available**:
  - `Files.Read` — Read user files
  - `Files.Read.All` — Read all files user can access
  - `Files.ReadWrite` — Read and write user files
  - `Files.ReadWrite.All` — Read and write all files
  - `Sites.Read.All` — Read SharePoint sites
  - `Sites.ReadWrite.All` — Read and write SharePoint sites
  - `User.Read` — Read user profile
  - `offline_access` — Refresh tokens

## Authorized URIs
- `https://graph.microsoft.com/*`

## Setup Guide
1. Register an application → https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
2. Configure API permissions (add Microsoft Graph delegated permissions for Files)
3. Create a client secret under Certificates & secrets

## Key Endpoints to Document
1. GET /me — Get current user
2. GET /me/drive — Get user's default drive
3. GET /me/drive/root/children — List root folder items
4. GET /me/drive/items/{item-id} — Get item metadata
5. GET /me/drive/items/{item-id}/content — Download file content
6. PUT /me/drive/items/{parent-id}:/{filename}:/content — Upload file (small)
7. POST /me/drive/items/{item-id}/createUploadSession — Upload file (large, resumable)
8. GET /me/drive/root:/path/to/file — Get item by path
9. POST /me/drive/items/{item-id}/copy — Copy item
10. PATCH /me/drive/items/{item-id} — Update item (rename/move)
11. DELETE /me/drive/items/{item-id} — Delete item
12. GET /me/drive/search(q='{query}') — Search files

## Compatibility Notes
- Same Microsoft Graph OAuth2 pattern as Outlook/Teams
- `offline_access` scope required for refresh tokens
- Large file uploads (>4MB) require upload sessions
- File paths use colon syntax: `/me/drive/root:/Documents/file.txt:/content`
- OData query parameters supported ($select, $filter, $expand, $top)
- SharedWithMe items accessible via `/me/drive/sharedWithMe`
