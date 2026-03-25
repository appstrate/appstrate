# Gmail API

Base URL: `https://gmail.googleapis.com/gmail/v1`

## Quick Reference

Google's email service API. Read, send, draft, and manage emails and labels programmatically.
User endpoints are scoped to `/users/me/` (the authenticated user).

## Key Endpoints

### List Messages
GET /users/me/messages
Returns message IDs (not full content). Use `q` for Gmail search syntax.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10&q=is:unread" \
  -H "Authorization: Bearer {{token}}"
```

### Get Message
GET /users/me/messages/{id}
Returns full message content. Use `format=full` for headers+body, `metadata` for headers only.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages/{MESSAGE_ID}?format=full" \
  -H "Authorization: Bearer {{token}}"
```

### Send Message
POST /users/me/messages/send
Send an email. Body must be a base64url-encoded RFC 2822 message in `raw` field.

**Example:**
```bash
# Build the raw RFC 2822 message, then base64url-encode it
RAW=$(printf 'From: me\nTo: recipient@example.com\nSubject: Hello\nContent-Type: text/plain\n\nBody text' | base64 | tr '+/' '-_' | tr -d '=\n')

curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages/send" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d "{\"raw\": \"$RAW\"}"
```

### List Labels
GET /users/me/labels
Returns all labels (system + user-created).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Authorization: Bearer {{token}}"
```

### Modify Message Labels
POST /users/me/messages/{id}/modify
Add or remove labels from a message (e.g., mark as read, archive).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/messages/{MESSAGE_ID}/modify" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"removeLabelIds": ["UNREAD"], "addLabelIds": ["STARRED"]}'
```

### Create Draft
POST /users/me/drafts
Create a draft email.

**Example:**
```bash
RAW=$(printf 'From: me\nTo: recipient@example.com\nSubject: Draft\n\nDraft body' | base64 | tr '+/' '-_' | tr -d '=\n')

curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/drafts" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d "{\"message\": {\"raw\": \"$RAW\"}}"
```

### List Threads
GET /users/me/threads
Returns conversation threads. Same search syntax as messages.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: gmail" \
  -H "X-Target: https://gmail.googleapis.com/gmail/v1/users/me/threads?maxResults=5" \
  -H "Authorization: Bearer {{token}}"
```

## Common Patterns

### Pagination
Responses include `nextPageToken`. Pass it as `pageToken` query param for the next page.

### Message Format
- `format=full`: Complete message with parsed headers and body parts
- `format=metadata`: Headers only (faster, use `metadataHeaders` to filter)
- `format=minimal`: IDs and labels only (fastest)
- `format=raw`: Base64url-encoded RFC 2822 (for forwarding/re-sending)

### Search Syntax (q parameter)
Gmail search operators work in the `q` parameter:
- `is:unread` -- unread messages
- `from:user@example.com` -- from specific sender
- `subject:invoice` -- subject contains "invoice"
- `after:2024/01/01 before:2024/12/31` -- date range
- `has:attachment filename:pdf` -- with PDF attachments
- `label:important` -- with specific label

### Reading Email Body
Message bodies are in `payload.parts[].body.data` (base64url-encoded). For multipart messages, iterate parts and check `mimeType` (`text/plain` or `text/html`).

## Important Notes

- Message IDs are immutable. Thread IDs group related messages.
- The `INBOX`, `SENT`, `TRASH`, `SPAM`, `UNREAD`, `STARRED` labels are system labels.
- Batch requests: POST to `https://gmail.googleapis.com/batch/gmail/v1` with multipart/mixed body.
- Rate limit: 250 quota units/second per user. List = 5 units, get = 5 units, send = 100 units.
- Response bodies may exceed 50KB (long emails) -- sidecar will truncate. Use `format=metadata` when you only need headers.