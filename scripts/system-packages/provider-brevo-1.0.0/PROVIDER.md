# Brevo API

Base URL: `https://api.brevo.com/v3`

## Quick Reference

Email marketing and transactional email platform (formerly Sendinblue). Send emails, manage contacts, and handle campaigns.

## Key Endpoints

### Send Transactional Email
POST /smtp/email
Send a transactional email.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/smtp/email" \
  -H "api-key: {{api_key}}" \
  -H "Content-Type: application/json" \
  -d '{"sender": {"name": "App", "email": "noreply@example.com"}, "to": [{"email": "user@example.com", "name": "User"}], "subject": "Hello", "htmlContent": "<p>Hello from Appstrate!</p>"}'
```

### List Contacts
GET /contacts
List all contacts with pagination.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/contacts?limit=10&offset=0" \
  -H "api-key: {{api_key}}"
```

### Get Contact
GET /contacts/{identifier}
Get a contact by email or ID.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/contacts/user@example.com" \
  -H "api-key: {{api_key}}"
```

### Create Contact
POST /contacts
Create a new contact.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/contacts" \
  -H "api-key: {{api_key}}" \
  -H "Content-Type: application/json" \
  -d '{"email": "new@example.com", "attributes": {"FIRSTNAME": "Jane", "LASTNAME": "Doe"}, "listIds": [1]}'
```

### Update Contact
PUT /contacts/{identifier}
Update contact attributes or list membership.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PUT \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/contacts/user@example.com" \
  -H "api-key: {{api_key}}" \
  -H "Content-Type: application/json" \
  -d '{"attributes": {"FIRSTNAME": "Updated"}, "listIds": [1, 2]}'
```

### List Contact Lists
GET /contacts/lists
Get all contact lists.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/contacts/lists?limit=10&offset=0" \
  -H "api-key: {{api_key}}"
```

### Get Email Campaigns
GET /emailCampaigns
List email campaigns.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/emailCampaigns?limit=10&offset=0&status=sent" \
  -H "api-key: {{api_key}}"
```

### Get Transactional Email Events
GET /smtp/statistics/events
Get delivery events (sent, delivered, opened, clicked, bounced).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: brevo" \
  -H "X-Target: https://api.brevo.com/v3/smtp/statistics/events?limit=10&event=delivered" \
  -H "api-key: {{api_key}}"
```

## Common Patterns

### Pagination
Uses `limit` and `offset` query parameters. Response includes `count` (total items).
Max `limit` varies by endpoint (typically 50 or 1000).

### Contact Attributes
Attributes use uppercase names: `FIRSTNAME`, `LASTNAME`, `SMS`, etc.
Custom attributes must be created in the Brevo dashboard first.

### Transactional Email Options
- `htmlContent` or `textContent` for body
- `templateId` to use a pre-built template (with `params` for placeholders)
- `attachment` array with `{name, content}` (base64-encoded content)
- `replyTo` for reply address
- `tags` array for categorization

## Important Notes

- Auth header is `api-key` (lowercase, no prefix) -- not `Authorization: Bearer`.
- Rate limit: depends on plan. Free tier: 300 emails/day. API rate: 400 requests/minute.
- Sender email must be verified in Brevo dashboard before sending.
- Contact identifier can be email address or numeric ID.
- Transactional emails and marketing campaigns are separate systems.