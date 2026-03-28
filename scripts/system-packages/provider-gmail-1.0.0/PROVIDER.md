# Gmail API

Base URL: `https://gmail.googleapis.com/gmail/v1`

Google's email service API. Read, send, draft, and manage emails and labels programmatically. All user endpoints are scoped to `/users/me/` (the authenticated user).

## Endpoints

### List Messages
`GET /users/me/messages`

Returns message IDs and thread IDs (not full content). Use `q` for Gmail search syntax.

**Query parameters:**
- `q` — Gmail search query (see Search Syntax below)
- `maxResults` — Max messages to return (default 100, max 500)
- `pageToken` — Token for next page
- `labelIds` — Filter by label IDs (repeatable)
- `includeSpamTrash` — Include messages from SPAM and TRASH (boolean, default `false`)

**Response:**
```json
{
  "messages": [
    { "id": "18a1b2c3d4e5f6a7", "threadId": "18a1b2c3d4e5f6a7" }
  ],
  "nextPageToken": "...",
  "resultSizeEstimate": 42
}
```

### Get Message
`GET /users/me/messages/{MESSAGE_ID}`

Returns full message content.

**Query parameters:**
- `format` — `full` (default, headers+body), `metadata` (headers only), `minimal` (IDs and labels only), `raw` (base64url-encoded RFC 2822)
- `metadataHeaders` — When `format=metadata`, filter which headers to return (repeatable, e.g. `Subject`, `From`)

**Response (format=full):**
```json
{
  "id": "...",
  "threadId": "...",
  "labelIds": ["INBOX", "UNREAD"],
  "snippet": "Preview text...",
  "payload": {
    "headers": [
      { "name": "From", "value": "sender@example.com" },
      { "name": "Subject", "value": "Hello" }
    ],
    "mimeType": "multipart/alternative",
    "parts": [
      { "mimeType": "text/plain", "body": { "data": "<base64url-encoded>" } },
      { "mimeType": "text/html", "body": { "data": "<base64url-encoded>" } }
    ]
  }
}
```

### Send Message
`POST /users/me/messages/send`

Send an email. Body must contain a base64url-encoded RFC 2822 message in the `raw` field.

**Request body:**
```json
{
  "raw": "<base64url-encoded RFC 2822 message>"
}
```

To build the `raw` value: construct an RFC 2822 message string with `From`, `To`, `Subject` headers and body, then base64url-encode it (base64 with `+/` replaced by `-_`, no padding `=`).

### List Labels
`GET /users/me/labels`

Returns all labels (system + user-created).

**Response:**
```json
{
  "labels": [
    { "id": "INBOX", "name": "INBOX", "type": "system" },
    { "id": "Label_1", "name": "My Label", "type": "user" }
  ]
}
```

### Modify Message Labels
`POST /users/me/messages/{MESSAGE_ID}/modify`

Add or remove labels from a message. Use this to mark as read, star, archive, etc.

**Request body:**
```json
{
  "addLabelIds": ["STARRED"],
  "removeLabelIds": ["UNREAD"]
}
```

Common operations:
- Mark as read: `removeLabelIds: ["UNREAD"]`
- Archive: `removeLabelIds: ["INBOX"]`
- Star: `addLabelIds: ["STARRED"]`
- Move to trash: prefer `POST .../trash` endpoint over label modification

### Create Draft
`POST /users/me/drafts`

Create a draft email.

**Request body:**
```json
{
  "message": {
    "raw": "<base64url-encoded RFC 2822 message>"
  }
}
```

### List Drafts
`GET /users/me/drafts`

List all drafts.

**Query parameters:**
- `maxResults` — Max drafts to return
- `pageToken` — Token for next page

### Send Draft
`POST /users/me/drafts/send`

Send an existing draft.

**Request body:**
```json
{
  "id": "{DRAFT_ID}"
}
```

### List Threads
`GET /users/me/threads`

Returns conversation threads. Same search syntax as messages via `q` parameter.

**Query parameters:**
- `q` — Search query
- `maxResults` — Max threads to return
- `pageToken` — Token for next page
- `labelIds` — Filter by label IDs (repeatable)
- `includeSpamTrash` — Include threads from SPAM and TRASH (boolean, default `false`)

### Trash Message
`POST /users/me/messages/{MESSAGE_ID}/trash`

Move a message to trash. Preferred over label modification for trashing.

### Untrash Message
`POST /users/me/messages/{MESSAGE_ID}/untrash`

Remove a message from trash.

### Get Attachment
`GET /users/me/messages/{MESSAGE_ID}/attachments/{ATTACHMENT_ID}`

Download attachment data. Returns a base64url-encoded `data` field.

**Response:**
```json
{
  "attachmentId": "...",
  "size": 12345,
  "data": "<base64url-encoded attachment data>"
}
```

### Get Thread
`GET /users/me/threads/{THREAD_ID}`

Returns all messages in a thread.

**Query parameters:**
- `format` — Same as Get Message (`full`, `metadata`, `minimal`)

## Common Patterns

### Pagination
Responses include `nextPageToken`. Pass it as `pageToken` query parameter for the next page.

### Message Format Options
- `format=full` — Complete message with parsed headers and body parts
- `format=metadata` — Headers only (faster, use `metadataHeaders` to filter)
- `format=minimal` — IDs and labels only (fastest)
- `format=raw` — Base64url-encoded RFC 2822 (for forwarding/re-sending)

### Search Syntax (q parameter)
Gmail search operators work in the `q` parameter:
- `is:unread` — unread messages
- `from:user@example.com` — from specific sender
- `to:user@example.com` — to specific recipient
- `subject:invoice` — subject contains "invoice"
- `after:2024/01/01 before:2024/12/31` — date range
- `has:attachment filename:pdf` — with PDF attachments
- `label:important` — with specific label
- `in:inbox` — in inbox
- `is:starred` — starred messages

### Reading Email Body
Message bodies are in `payload.parts[].body.data` (base64url-encoded). For multipart messages, iterate parts and check `mimeType` (`text/plain` or `text/html`). For simple messages, the body may be directly in `payload.body.data`.

## Important Notes

- Message IDs are immutable. Thread IDs group related messages.
- System labels: `INBOX`, `SENT`, `TRASH`, `SPAM`, `UNREAD`, `STARRED`, `IMPORTANT`, `DRAFT`.
- Rate limit: 250 quota units/second per user. List = 5 units, Get = 5 units, Send = 100 units.
- Batch requests: POST to `https://www.googleapis.com/batch/gmail/v1` with multipart/mixed body.
- Use `format=metadata` when you only need headers — full messages with attachments can be very large.
