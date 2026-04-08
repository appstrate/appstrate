# Telegram Provider

Base URL: `https://api.telegram.org/bot{{bot_token}}`

## Important: Token in URL Path

Telegram Bot API embeds the bot token **in the URL path**, not in a header. All requests follow this pattern:

```
https://api.telegram.org/bot{{bot_token}}/{method}
```

The sidecar substitutes `{{bot_token}}` automatically. No `Authorization` header is used.

## Key Endpoints

### Get Bot Info

```
GET https://api.telegram.org/bot{{bot_token}}/getMe
```

### Send Message

```
POST https://api.telegram.org/bot{{bot_token}}/sendMessage
Content-Type: application/json

{
  "chat_id": 123456789,
  "text": "Hello from Appstrate!",
  "parse_mode": "HTML"
}
```

`parse_mode`: `HTML`, `Markdown`, or `MarkdownV2`.

### Send Photo

```
POST https://api.telegram.org/bot{{bot_token}}/sendPhoto
Content-Type: application/json

{
  "chat_id": 123456789,
  "photo": "https://example.com/image.jpg",
  "caption": "Photo description"
}
```

### Send Document

```
POST https://api.telegram.org/bot{{bot_token}}/sendDocument
Content-Type: application/json

{
  "chat_id": 123456789,
  "document": "https://example.com/file.pdf",
  "caption": "Document description"
}
```

### Get Updates (Polling)

```
GET https://api.telegram.org/bot{{bot_token}}/getUpdates
```

Supports `?offset=`, `?limit=100`, `?timeout=30` (long polling).

### Set Webhook

```
POST https://api.telegram.org/bot{{bot_token}}/setWebhook
Content-Type: application/json

{
  "url": "https://your-server.com/webhook"
}
```

### Delete Webhook

```
POST https://api.telegram.org/bot{{bot_token}}/deleteWebhook
```

### Forward Message

```
POST https://api.telegram.org/bot{{bot_token}}/forwardMessage
Content-Type: application/json

{
  "chat_id": 123456789,
  "from_chat_id": 987654321,
  "message_id": 42
}
```

### Edit Message

```
POST https://api.telegram.org/bot{{bot_token}}/editMessageText
Content-Type: application/json

{
  "chat_id": 123456789,
  "message_id": 42,
  "text": "Updated message text"
}
```

### Get Chat Info

```
GET https://api.telegram.org/bot{{bot_token}}/getChat?chat_id=123456789
```

### Get Chat Member Count

```
GET https://api.telegram.org/bot{{bot_token}}/getChatMemberCount?chat_id=123456789
```

### Send Location

```
POST https://api.telegram.org/bot{{bot_token}}/sendLocation
Content-Type: application/json

{
  "chat_id": 123456789,
  "latitude": 48.8566,
  "longitude": 2.3522
}
```

## Notes

- All methods accept both GET (query params) and POST (JSON body)
- POST with `multipart/form-data` required for file uploads from disk
- Bots can only message users who have started a conversation with the bot first
- `chat_id` can be numeric (user/group) or `@username` (public channels)
- Rate limits: ~30 messages/second to different chats, 1 message/second per chat
- Updates via polling (`getUpdates`) or webhooks (`setWebhook`) — not both simultaneously
