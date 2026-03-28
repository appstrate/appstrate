# Brevo API

Base URL: `https://api.brevo.com/v3`

Email marketing and transactional email platform (formerly Sendinblue). Send emails, manage contacts, and handle campaigns.

## Endpoints

### Send Transactional Email
`POST /v3/smtp/email`

**Request body:**
```json
{
  "sender": { "name": "App", "email": "noreply@example.com" },
  "to": [{ "email": "user@example.com", "name": "User" }],
  "subject": "Hello",
  "htmlContent": "<p>Hello!</p>"
}
```

Additional options:
- `textContent` — plain text alternative
- `templateId` — use a pre-built template (with `params` for placeholders)
- `attachment` — array of `{ "name": "file.pdf", "content": "base64-encoded" }`
- `replyTo` — `{ "email": "reply@example.com" }`
- `tags` — array of strings for categorization
- `cc`, `bcc` — arrays of `{ "email": "...", "name": "..." }`

**Response:**
```json
{
  "messageId": "<message-id@smtp-relay.brevo.com>"
}
```

### List Contacts
`GET /v3/contacts`

**Query parameters:**
- `limit` — max results (default 50)
- `offset` — pagination offset
- `modifiedSince` — ISO 8601 date filter
- `sort` — `asc` or `desc`

**Response:**
```json
{
  "contacts": [
    {
      "email": "user@example.com",
      "id": 123,
      "attributes": { "FIRSTNAME": "Jane", "LASTNAME": "Doe" },
      "listIds": [1, 2]
    }
  ],
  "count": 150
}
```

### Get Contact
`GET /v3/contacts/{IDENTIFIER}`

Get a contact by email address or numeric ID.

### Create Contact
`POST /v3/contacts`

**Request body:**
```json
{
  "email": "new@example.com",
  "attributes": { "FIRSTNAME": "Jane", "LASTNAME": "Doe" },
  "listIds": [1]
}
```

### Update Contact
`PUT /v3/contacts/{IDENTIFIER}`

**Request body:**
```json
{
  "attributes": { "FIRSTNAME": "Updated" },
  "listIds": [1, 2]
}
```

### List Contact Lists
`GET /v3/contacts/lists`

**Query parameters:**
- `limit` — max results
- `offset` — pagination offset
- `sort` — `asc` or `desc`

### Get Email Campaigns
`GET /v3/emailCampaigns`

**Query parameters:**
- `limit`, `offset`
- `status` — `draft`, `sent`, `archive`, `queued`, `suspended`
- `sort` — `asc` or `desc`

### Get Transactional Email Events
`GET /v3/smtp/statistics/events`

Get delivery events (sent, delivered, opened, clicked, bounced).

**Query parameters:**
- `limit`, `offset`
- `event` — `delivered`, `opened`, `clicks`, `hardBounces`, `softBounces`, `spam`, `unsubscribed`, `bounces`, `requests`, `invalid`, `deferred`, `blocked`, `error`, `loadedByProxy`
- `startDate`, `endDate` — ISO 8601 dates
- `email` — filter by recipient email
- `messageId` — filter by message ID
- `tags` — filter by tag

## Common Patterns

### Pagination
Uses `limit` and `offset` query parameters. Response includes `count` (total items). Max `limit` varies by endpoint (typically 50 or 1000).

### Contact Attributes
Attributes use uppercase names: `FIRSTNAME`, `LASTNAME`, `SMS`, etc. Custom attributes must be created in the Brevo dashboard first.

### Date Format
ISO 8601: `2024-01-15T09:30:00.000Z`

## Important Notes

- Rate limit: depends on plan. Free tier: 300 emails/day. Rate limits vary by endpoint and plan (e.g., contacts: ~10 RPS, email sending: ~1,000 RPS on General tier). See official docs for tier-specific limits.
- Sender email must be verified in the Brevo dashboard before sending.
- Contact identifier can be an email address or numeric ID.
- When updating contacts, the `listIds` field appends to existing lists (does not replace). Use `unlinkListIds` to remove from lists.
- Transactional emails and marketing campaigns are separate systems.
