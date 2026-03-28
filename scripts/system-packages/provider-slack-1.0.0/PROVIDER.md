# Slack API

Base URL: `https://slack.com/api`

Team messaging API. Send messages, read channels, manage users. All endpoints use the base URL with the method name in the URL path (e.g. `/api/chat.postMessage`).

## Endpoints

### Send Message
`POST /chat.postMessage`

Send a message to a channel.

**Request body:**
```json
{
  "channel": "{CHANNEL_ID}",
  "text": "Hello, world!"
}
```

For rich formatting, use the `blocks` array (see Block Kit below). When using `blocks`, always include `text` as a fallback — it is used for notifications and accessibility when blocks cannot be rendered.

### Update Message
`POST /chat.update`

Edit an existing message.

**Request body:**
```json
{
  "channel": "{CHANNEL_ID}",
  "ts": "1234567890.123456",
  "text": "Updated message text"
}
```

### Delete Message
`POST /chat.delete`

Delete a message.

**Request body:**
```json
{
  "channel": "{CHANNEL_ID}",
  "ts": "1234567890.123456"
}
```

### List Channels
`GET /conversations.list`

List channels the bot has access to.

**Query parameters:**
- `types` — Channel types: `public_channel`, `private_channel`, `mpim`, `im` (comma-separated)
- `limit` — Max results per page (default 100, max 1000)
- `cursor` — Pagination cursor
- `exclude_archived` — Exclude archived channels (`true`/`false`)

**Response:**
```json
{
  "ok": true,
  "channels": [
    { "id": "C01234ABCDE", "name": "general", "is_private": false, "num_members": 42 }
  ],
  "response_metadata": { "next_cursor": "..." }
}
```

### Read Channel History
`GET /conversations.history`

Get messages from a channel.

**Query parameters:**
- `channel` — Channel ID (required)
- `limit` — Number of messages (default 100, max 1000)
- `cursor` — Pagination cursor
- `oldest` — Start of time range (Unix timestamp)
- `latest` — End of time range (Unix timestamp)
- `inclusive` — Include messages with oldest/latest timestamps (`true`/`false`)

**Response:**
```json
{
  "ok": true,
  "messages": [
    { "type": "message", "user": "U01234ABCDE", "text": "Hello", "ts": "1234567890.123456" }
  ],
  "has_more": true,
  "response_metadata": { "next_cursor": "..." }
}
```

### Reply in Thread
`POST /chat.postMessage`

Reply in a thread by specifying `thread_ts`.

**Request body:**
```json
{
  "channel": "{CHANNEL_ID}",
  "text": "Thread reply",
  "thread_ts": "1234567890.123456"
}
```

### Get Thread Replies
`GET /conversations.replies`

Get all replies in a thread.

**Query parameters:**
- `channel` — Channel ID (required)
- `ts` — Thread parent message timestamp (required)
- `limit` — Max replies to return
- `cursor` — Pagination cursor

### List Users
`GET /users.list`

List all users in the workspace.

**Query parameters:**
- `limit` — Max results per page (default 100)
- `cursor` — Pagination cursor

### Get User Info
`GET /users.info`

Get detailed info about a user.

**Query parameters:**
- `user` — User ID (required)

**Response:**
```json
{
  "ok": true,
  "user": {
    "id": "U01234ABCDE",
    "name": "johndoe",
    "real_name": "John Doe",
    "profile": { "email": "john@example.com", "image_48": "https://..." }
  }
}
```

### Add Reaction
`POST /reactions.add`

Add an emoji reaction to a message.

**Request body:**
```json
{
  "channel": "{CHANNEL_ID}",
  "name": "thumbsup",
  "timestamp": "1234567890.123456"
}
```

### Get Channel Info
`GET /conversations.info`

Get detailed information about a channel.

**Query parameters:**
- `channel` — Channel ID (required)

### Upload File

Upload a file in 3 steps (`files.upload` was sunset March 2025):

**Step 1** — Get an upload URL:
`GET /files.getUploadURLExternal`

**Query parameters:**
- `filename` — File name (required)
- `length` — File size in bytes (required)

**Response:**
```json
{
  "ok": true,
  "upload_url": "https://files.slack.com/upload/v1/...",
  "file_id": "F01234ABCDE"
}
```

**Step 2** — POST the file content to the returned `upload_url` (this is a direct upload, not a Slack API call).

**Step 3** — Complete the upload:
`POST /files.completeUploadExternal`

**Request body:**
```json
{
  "files": [
    { "id": "F01234ABCDE", "title": "My File" }
  ],
  "channel_id": "{CHANNEL_ID}"
}
```

The `channel_id` field is optional — omit it to upload without sharing to a channel.

## Common Patterns

### Pagination
Uses cursor-based pagination. Response includes `response_metadata.next_cursor`. Pass as `cursor` parameter in the next request. Empty string means no more results.

### Message Formatting (mrkdwn)
- Bold: `*text*`
- Italic: `_text_`
- Strikethrough: `~text~`
- Code: `` `code` ``
- Code block: ` ```code``` `
- Link: `<https://example.com|Display Text>`
- User mention: `<@U01234ABCDE>`
- Channel mention: `<#C01234ABCDE>`

### Block Kit (Rich Messages)
Use the `blocks` array for structured messages:
```json
{
  "channel": "{CHANNEL_ID}",
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn", "text": "*Title*\nDescription text" } },
    { "type": "divider" },
    { "type": "section", "text": { "type": "mrkdwn", "text": "More content" } }
  ]
}
```

### Message Timestamps
Messages are identified by `ts` (timestamp like `1234567890.123456`). This serves as the unique message ID within a channel.

## Important Notes

- All API responses include `"ok": true` or `"ok": false`. Always check the `ok` field before reading data. Errors include an `error` field with a machine-readable code.
- Channel IDs start with `C` (channels, including some Slack Connect), `G` (private/group), or `D` (DMs). User IDs start with `U`. Bot IDs start with `B`. The `C` prefix does not reliably indicate public — unshared Slack Connect channels also use `C`. Use the `is_private` field from the API response instead of relying on prefixes.
- The bot must be invited to a channel before it can post or read history.
- Rate limits are tiered per method: Tier 1 (~1/min, e.g. admin methods), Tier 2 (~20/min, e.g. `conversations.list`), Tier 3 (~50/min, e.g. `conversations.history`), Tier 4 (~100/min, e.g. `chat.postMessage`).
- File uploads use the 3-step process (`getUploadURLExternal` + upload + `completeUploadExternal`). The legacy `files.upload` was sunset March 2025.
- Scopes determine access. Common: `channels:read`, `chat:write`, `users:read`, `files:write`.
