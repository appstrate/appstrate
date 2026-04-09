# Discord API

Base URL: `https://discord.com/api/v10`

Communication platform for communities. Manage guilds (servers), channels, messages, and webhooks. This provider uses User OAuth2 tokens (Bearer) — all operations are performed on behalf of the authenticated user.

## Endpoints

### Get Current User
`GET /users/@me`

Returns the user object of the authenticated user. Requires `identify` scope.

**Response:**
```json
{
  "id": "80351110224678912",
  "username": "nelly",
  "global_name": "Nelly",
  "avatar": "8342729096ea3675442027381ff50dfe",
  "email": "nelly@discord.com",
  "verified": true,
  "locale": "en-US"
}
```

### List Current User Guilds
`GET /users/@me/guilds`

Returns a list of guilds the current user is a member of. Requires `guilds` scope.

**Query parameters:**
- `before` — Get guilds before this guild ID
- `after` — Get guilds after this guild ID
- `limit` — Max number of guilds (1-200, default 200)
- `with_counts` — Include approximate member and presence counts (boolean)

**Response:**
```json
[
  {
    "id": "80351110224678912",
    "name": "1337 Krew",
    "icon": "8342729096ea3675442027381ff50dfe",
    "owner": true,
    "permissions": "36953089",
    "approximate_member_count": 3,
    "approximate_presence_count": 1
  }
]
```

### Get Current User Connections
`GET /users/@me/connections`

Returns a list of connected accounts (Twitch, YouTube, etc.). Requires `connections` scope.

### Get Guild
`GET /guilds/{GUILD_ID}`

Returns the guild object for the given ID.

**Query parameters:**
- `with_counts` — Include approximate member/presence counts (boolean)

### Get Guild Channels
`GET /guilds/{GUILD_ID}/channels`

Returns a list of channels in a guild. Does not include threads.

**Response:**
```json
[
  {
    "id": "41771983423143937",
    "guild_id": "290926798626357250",
    "name": "general",
    "type": 0,
    "position": 6,
    "topic": "24/7 chat"
  }
]
```

Channel types: `0` = Text, `2` = Voice, `4` = Category, `5` = Announcement, `13` = Stage, `15` = Forum, `16` = Media

### Get Guild Members
`GET /guilds/{GUILD_ID}/members`

Returns a list of guild members. Requires `guilds.members.read` scope or bot with proper permissions.

**Query parameters:**
- `limit` — Max members to return (1-1000, default 1)
- `after` — Get members after this user ID

### Get Channel Messages
`GET /channels/{CHANNEL_ID}/messages`

Returns messages in a channel. Requires `messages.read` scope or appropriate permissions.

**Query parameters:**
- `around` — Get messages around this message ID
- `before` — Get messages before this message ID
- `after` — Get messages after this message ID
- `limit` — Max messages to return (1-100, default 50)

**Response:**
```json
[
  {
    "id": "334385199974967042",
    "channel_id": "290926798999357250",
    "author": {
      "id": "80351110224678912",
      "username": "nelly"
    },
    "content": "Hello!",
    "timestamp": "2017-07-11T17:27:07.299000+00:00",
    "edited_timestamp": null,
    "attachments": [],
    "embeds": [],
    "reactions": []
  }
]
```

### Send Message
`POST /channels/{CHANNEL_ID}/messages`

Post a message to a channel. Requires appropriate permissions.

**Request body (JSON):**
```json
{
  "content": "Hello, World!",
  "tts": false,
  "embeds": [
    {
      "title": "Hello",
      "description": "This is an embed",
      "color": 5814783,
      "fields": [
        { "name": "Field 1", "value": "Value 1", "inline": true }
      ]
    }
  ]
}
```

At least one of `content`, `embeds`, `sticker_ids`, or `components` must be present.

### Edit Message
`PATCH /channels/{CHANNEL_ID}/messages/{MESSAGE_ID}`

Edit a previously sent message. Only the message author can edit.

**Request body (JSON):**
```json
{
  "content": "Updated message content"
}
```

### Delete Message
`DELETE /channels/{CHANNEL_ID}/messages/{MESSAGE_ID}`

Delete a message. Requires appropriate permissions.

### Add Reaction
`PUT /channels/{CHANNEL_ID}/messages/{MESSAGE_ID}/reactions/{EMOJI}/@me`

Add a reaction to a message. `{EMOJI}` is URL-encoded (e.g. `%F0%9F%91%8D` for 👍, or `name:id` for custom emojis).

### Remove Reaction
`DELETE /channels/{CHANNEL_ID}/messages/{MESSAGE_ID}/reactions/{EMOJI}/@me`

Remove own reaction from a message.

### Create Webhook
`POST /channels/{CHANNEL_ID}/webhooks`

Create a new webhook for a channel.

**Request body (JSON):**
```json
{
  "name": "my-webhook",
  "avatar": null
}
```

### Execute Webhook
`POST /webhooks/{WEBHOOK_ID}/{WEBHOOK_TOKEN}`

Execute a webhook (send a message). No authentication required — the token in the URL acts as auth.

**Request body (JSON):**
```json
{
  "content": "Hello from webhook!",
  "username": "Custom Name",
  "avatar_url": "https://...",
  "embeds": []
}
```

**Query parameters:**
- `wait` — Wait for message to be created and return it (`true`/`false`)
- `thread_id` — Send to a specific thread in the channel

## Common Patterns

### Snowflake IDs
All Discord IDs are Snowflake IDs (large integers as strings). They encode creation timestamp, worker ID, and sequence. Always treat them as strings, not numbers.

### Message Embeds
Rich content is sent via `embeds` array. Each embed can have:
- `title`, `description`, `url`, `color` (integer)
- `fields[]` with `name`, `value`, `inline`
- `author` with `name`, `url`, `icon_url`
- `thumbnail`, `image`, `footer`
- Max 10 embeds per message, max 6000 total characters across all embeds

### Permissions
Permissions are bitfields. Common values:
- `0x0000000000000800` — Send Messages (2048)
- `0x0000000000010000` — Read Message History (65536)
- `0x0000000020000000` — Manage Webhooks (536870912)

### Rate Limits
Discord uses per-route rate limiting.
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- `X-RateLimit-Bucket` — Unique rate limit bucket
- Global rate limit: 50 requests/second
- On 429 status: response body contains `retry_after` (seconds)

### Error Format
```json
{
  "code": 50001,
  "message": "Missing Access",
  "errors": {}
}
```

Common error codes:
- `10003` — Unknown Channel
- `10004` — Unknown Guild
- `50001` — Missing Access
- `50013` — Missing Permissions
- `50035` — Invalid Form Body

## Important Notes
- All endpoints use API version 10 (`/api/v10/`).
- IDs are Snowflake strings (not integers) — always treat as strings.
- Messages are limited to 2000 characters for `content`.
- Embeds limited to 6000 characters total.
- File uploads use `multipart/form-data` with `payload_json` for metadata.
- User OAuth2 tokens have limited guild actions — many management endpoints require a Bot token.
- Gateway (WebSocket) is NOT available through REST API — for real-time events, use a bot.
- Webhooks are the simplest way to send messages to a channel without a bot.
