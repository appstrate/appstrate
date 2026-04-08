# IMPL: Telegram Provider

## Provider Info
- **Slug**: `telegram`
- **Display Name**: Telegram
- **Auth Mode**: API Key (Bot Token)
- **Base URL**: `https://api.telegram.org/bot{token}`
- **Docs**: https://core.telegram.org/bots/api

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `bot_token` (string) — Telegram Bot API token (from @BotFather)
- **Note**: Token is embedded in the URL path, not in a header. The sidecar should inject it as part of the base URL.

## ⚠️ Compatibility Note
Telegram Bot API uses the token **in the URL** (`/bot{token}/method`), not in a header. Options:
1. Use `allowAllUris: true` and document that the agent must include the token in the URL
2. Use `credentialHeaderName` with a custom approach

**Recommendation**: Use `allowAllUris: true` and document the URL pattern. The agent constructs URLs as `https://api.telegram.org/bot{token}/{method}`.

## Authorized URIs
- `https://api.telegram.org/*`

## Setup Guide
1. Open Telegram and message @BotFather → https://t.me/BotFather
2. Create a new bot with `/newbot` command
3. Copy the bot token provided by BotFather

## Key Endpoints to Document
1. GET /bot{token}/getMe — Get bot info
2. POST /bot{token}/sendMessage — Send text message
3. POST /bot{token}/sendPhoto — Send photo
4. POST /bot{token}/sendDocument — Send document
5. GET /bot{token}/getUpdates — Get incoming updates (polling)
6. POST /bot{token}/setWebhook — Set webhook URL
7. POST /bot{token}/deleteWebhook — Delete webhook
8. POST /bot{token}/sendLocation — Send location
9. POST /bot{token}/forwardMessage — Forward message
10. POST /bot{token}/editMessageText — Edit sent message
11. GET /bot{token}/getChat — Get chat info
12. GET /bot{token}/getChatMemberCount — Get chat member count

## Compatibility Notes
- Token in URL path (not header) — unique pattern
- All methods accept both GET and POST
- POST with JSON body or multipart/form-data (for file uploads)
- Bot can only interact with users who have started a conversation with it
- Updates can be received via polling (getUpdates) or webhooks
- Rate limits: ~30 messages/second to different chats, 1 message/second to same chat
- chat_id can be numeric (user/group) or @username (public channels)
