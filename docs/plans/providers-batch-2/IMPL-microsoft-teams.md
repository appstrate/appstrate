# IMPL: Microsoft Teams Provider

## Provider Info
- **Slug**: `microsoft-teams`
- **Display Name**: Microsoft Teams
- **Auth Mode**: OAuth2
- **Base URL**: `https://graph.microsoft.com/v1.0`
- **Docs**: https://learn.microsoft.com/en-us/graph/api/resources/teams-api-overview

## Auth Details
- **Authorization URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`
- **Token URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- **Refresh URL**: `https://login.microsoftonline.com/common/oauth2/v2.0/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `Team.ReadBasic.All` — Read teams
  - `Channel.ReadBasic.All` — Read channels
  - `Chat.Read` — Read chats
  - `User.Read` — Read user profile
  - `offline_access` — Refresh tokens
- **Available**:
  - `Team.ReadBasic.All` — Read teams
  - `Channel.ReadBasic.All` — Read channels
  - `ChannelMessage.Read.All` — Read channel messages
  - `Chat.Read` — Read chats
  - `Chat.ReadWrite` — Read and write chats
  - `ChatMessage.Send` — Send chat messages
  - `ChannelMessage.Send` — Send channel messages
  - `User.Read` — Read user profile
  - `User.ReadBasic.All` — Read all users basic info
  - `offline_access` — Refresh tokens

## Authorized URIs
- `https://graph.microsoft.com/*`

## Setup Guide
1. Register an application → https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
2. Configure API permissions (add Microsoft Graph delegated permissions for Teams)
3. Create a client secret under Certificates & secrets

## Key Endpoints to Document
1. GET /me — Get current user
2. GET /me/joinedTeams — List joined teams
3. GET /teams/{team-id} — Get team
4. GET /teams/{team-id}/channels — List channels
5. GET /teams/{team-id}/channels/{channel-id}/messages — List channel messages
6. POST /teams/{team-id}/channels/{channel-id}/messages — Post message to channel
7. GET /me/chats — List chats
8. GET /chats/{chat-id}/messages — List chat messages
9. POST /chats/{chat-id}/messages — Send chat message
10. GET /me/onlineMeetings — List online meetings

## Compatibility Notes
- Same Microsoft Graph OAuth2 pattern as Outlook/OneDrive
- `offline_access` scope required for refresh tokens
- Some Teams APIs require admin consent
- OData query parameters supported ($select, $filter, $top, etc.)
