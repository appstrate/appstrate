# Slack API

Base URL: `https://slack.com/api`

## Quick Reference

Team messaging API. Send messages, read channels, manage users. All endpoints use the base URL.
Method name is in the URL path (e.g., `/api/chat.postMessage`).

## Key Endpoints

### Send Message
POST /chat.postMessage
Send a message to a channel.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C01234ABCDE", "text": "Hello from Appstrate!"}'
```

### List Channels
GET /conversations.list
List public and private channels the bot is a member of.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=100" \
  -H "Authorization: Bearer {{token}}"
```

### Read Channel History
GET /conversations.history
Get messages from a channel.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/conversations.history?channel=C01234ABCDE&limit=20" \
  -H "Authorization: Bearer {{token}}"
```

### List Users
GET /users.list
List all users in the workspace.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/users.list?limit=100" \
  -H "Authorization: Bearer {{token}}"
```

### Get User Info
GET /users.info
Get detailed info about a user.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/users.info?user=U01234ABCDE" \
  -H "Authorization: Bearer {{token}}"
```

### Reply in Thread
POST /chat.postMessage
Reply in a thread by specifying `thread_ts`.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/chat.postMessage" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C01234ABCDE", "text": "Thread reply", "thread_ts": "1234567890.123456"}'
```

### Get Thread Replies
GET /conversations.replies
Get all replies in a thread.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/conversations.replies?channel=C01234ABCDE&ts=1234567890.123456" \
  -H "Authorization: Bearer {{token}}"
```

### Add Reaction
POST /reactions.add
Add an emoji reaction to a message.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: slack" \
  -H "X-Target: https://slack.com/api/reactions.add" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"channel": "C01234ABCDE", "name": "thumbsup", "timestamp": "1234567890.123456"}'
```

## Common Patterns

### Pagination
Uses cursor-based pagination. Response includes `response_metadata.next_cursor`.
Pass as `cursor` parameter in the next request. Empty string means no more results.

### Message Formatting
- Bold: `*text*`
- Italic: `_text_`
- Code: `` `code` ``
- Link: `<https://example.com|Display Text>`
- User mention: `<@U01234ABCDE>`
- Channel mention: `<#C01234ABCDE>`

### Block Kit (Rich Messages)
Use `blocks` array for structured messages:
```json
{
  "channel": "C01234ABCDE",
  "blocks": [
    {"type": "section", "text": {"type": "mrkdwn", "text": "*Title*"}},
    {"type": "divider"},
    {"type": "section", "text": {"type": "mrkdwn", "text": "More content"}}
  ]
}
```

### Message Timestamps
Messages are identified by `ts` (timestamp like `1234567890.123456`). This is the message ID.

## Important Notes

- All API responses include `ok: true/false`. Check `ok` before reading data.
- Channel IDs start with `C` (public) or `G` (private). User IDs start with `U`.
- Bot must be invited to a channel before it can post or read history.
- Rate limit: ~1 request/second for most methods. Tier 1 (chat.postMessage) allows higher.
- File uploads use `files.uploadV2` (not the deprecated `files.upload`).
- Scopes determine access. Common: `channels:read`, `chat:write`, `users:read`.