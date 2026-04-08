# IMPL: Dropbox Provider

## Provider Info
- **Slug**: `dropbox`
- **Display Name**: Dropbox
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.dropboxapi.com/2`
- **Docs**: https://www.dropbox.com/developers/documentation/http/documentation

## Auth Details
- **Authorization URL**: `https://www.dropbox.com/oauth2/authorize`
- **Token URL**: `https://api.dropboxapi.com/oauth2/token`
- **Refresh URL**: `https://api.dropboxapi.com/oauth2/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_post`
- **Authorization Params**: `{ "token_access_type": "offline" }`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `account_info.read` — Read account info
  - `files.metadata.read` — Read file metadata
  - `files.content.read` — Read file content
- **Available**:
  - `account_info.read` — Read account info
  - `files.metadata.read` — Read file metadata
  - `files.metadata.write` — Write file metadata
  - `files.content.read` — Read file content
  - `files.content.write` — Write file content
  - `sharing.read` — Read shared files/folders
  - `sharing.write` — Manage shared files/folders
  - `file_requests.read` — Read file requests
  - `file_requests.write` — Manage file requests

## Authorized URIs
- `https://api.dropboxapi.com/*`
- `https://content.dropboxapi.com/*`

## Setup Guide
1. Create a Dropbox app → https://www.dropbox.com/developers/apps
2. Configure OAuth redirect URIs
3. Copy App Key (Client ID) and App Secret (Client Secret)

## Key Endpoints to Document
1. POST /2/users/get_current_account — Get current user
2. POST /2/files/list_folder — List folder contents
3. POST /2/files/list_folder/continue — Continue listing
4. POST /2/files/get_metadata — Get file/folder metadata
5. POST /2/files/download (content endpoint) — Download file
6. POST /2/files/upload (content endpoint) — Upload file
7. POST /2/files/search_v2 — Search files
8. POST /2/files/create_folder_v2 — Create folder
9. POST /2/files/delete_v2 — Delete file/folder
10. POST /2/files/move_v2 — Move file/folder
11. POST /2/sharing/list_shared_links — List shared links

## Compatibility Notes
- **All API calls are POST** (even reads) — unique to Dropbox
- `token_access_type: "offline"` required to get refresh tokens
- Content upload/download uses separate domain: `content.dropboxapi.com`
- File paths start with `/` (root of user's Dropbox)
- Pagination uses cursor-based pattern with `/continue` endpoints
