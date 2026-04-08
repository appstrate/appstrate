# IMPL: Microsoft Outlook Provider

## Provider Info
- **Slug**: `microsoft-outlook`
- **Display Name**: Microsoft Outlook
- **Auth Mode**: OAuth2
- **Base URL**: `https://graph.microsoft.com/v1.0`
- **Docs**: https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview

## Auth Details
- **Authorization URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- **Token URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- **Refresh URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `Mail.Read` — Read user mail
  - `User.Read` — Read user profile
  - `offline_access` — Refresh tokens
- **Available**:
  - `Mail.Read` — Read user mail
  - `Mail.ReadWrite` — Read and write mail
  - `Mail.Send` — Send mail
  - `Contacts.Read` — Read contacts
  - `Contacts.ReadWrite` — Read and write contacts
  - `Calendars.Read` — Read calendars
  - `Calendars.ReadWrite` — Read and write calendars
  - `User.Read` — Read user profile
  - `offline_access` — Refresh tokens

## Authorized URIs
- `https://graph.microsoft.com/*`

## Setup Guide
1. Register an application → https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
2. Configure API permissions (add Microsoft Graph delegated permissions)
3. Create a client secret under Certificates & secrets

## Key Endpoints to Document
1. GET /me — Get current user profile
2. GET /me/messages — List messages
3. GET /me/messages/{id} — Get message
4. POST /me/sendMail — Send a mail
5. POST /me/messages — Create draft
6. PATCH /me/messages/{id} — Update message
7. DELETE /me/messages/{id} — Delete message
8. GET /me/mailFolders — List mail folders
9. GET /me/messages?$search="" — Search messages
10. POST /me/messages/{id}/reply — Reply to message

## Compatibility Notes
- Uses Microsoft Graph API (shared with Teams, OneDrive, etc.)
- `offline_access` scope required for refresh tokens
- Uses `/common` tenant for multi-tenant apps
- OData query parameters ($select, $filter, $top, $skip, $orderby, $search)
