# Mailchimp API

Base URL: `https://{dc}.api.mailchimp.com/3.0`

Email marketing platform API for managing audiences, campaigns, automations, and analytics. The `{dc}` data center prefix (e.g. `us21`) is obtained from the OAuth metadata endpoint after authentication. Call `GET https://login.mailchimp.com/oauth2/metadata` with the access token to get the `api_endpoint`.

## Endpoints

### Get Account Info
`GET /`

Returns account details and API metadata.

**Response:**
```json
{
  "account_id": "abc123def456",
  "login_id": "john@example.com",
  "account_name": "Acme Corp",
  "email": "john@example.com",
  "first_name": "John",
  "last_name": "Doe",
  "total_subscribers": 5420
}
```

### List Audiences (Lists)
`GET /lists`

Returns all audiences (mailing lists).

**Query parameters:**
- `count` — Items per page (default 10, max 1000)
- `offset` — Number of items to skip

**Response:**
```json
{
  "lists": [
    {
      "id": "abc123",
      "name": "Newsletter Subscribers",
      "stats": {
        "member_count": 5420,
        "unsubscribe_count": 123,
        "open_rate": 0.32,
        "click_rate": 0.08
      },
      "date_created": "2023-01-15T10:00:00+00:00"
    }
  ],
  "total_items": 3
}
```

### Get Audience
`GET /lists/{listId}`

Returns details for a specific audience.

### List Members
`GET /lists/{listId}/members`

Returns members of an audience.

**Query parameters:**
- `count` — Items per page (default 10, max 1000)
- `offset` — Number of items to skip
- `status` — Filter by status: `subscribed`, `unsubscribed`, `cleaned`, `pending`, `transactional`
- `since_last_changed` — Filter by last change date (ISO 8601)

**Response:**
```json
{
  "members": [
    {
      "id": "e4b19db0...",
      "email_address": "alice@example.com",
      "status": "subscribed",
      "merge_fields": {
        "FNAME": "Alice",
        "LNAME": "Martin"
      },
      "tags": [
        { "id": 1, "name": "VIP" }
      ],
      "stats": {
        "avg_open_rate": 0.45,
        "avg_click_rate": 0.12
      },
      "timestamp_signup": "2024-01-10T08:00:00+00:00",
      "last_changed": "2024-06-15T10:30:00+00:00"
    }
  ],
  "total_items": 5420
}
```

### Add/Update Member
`PUT /lists/{listId}/members/{subscriberHash}`

Adds or updates a member. The `subscriberHash` is the MD5 hash of the lowercase email address.

**Request body (JSON):**
```json
{
  "email_address": "bob@example.com",
  "status": "subscribed",
  "merge_fields": {
    "FNAME": "Bob",
    "LNAME": "Wilson"
  },
  "tags": ["customer", "newsletter"]
}
```

### Delete Member
`DELETE /lists/{listId}/members/{subscriberHash}`

Permanently removes a member from the audience.

### List Campaigns
`GET /campaigns`

Returns all campaigns.

**Query parameters:**
- `count` — Items per page (default 10, max 1000)
- `offset` — Number of items to skip
- `status` — Filter: `save`, `paused`, `schedule`, `sending`, `sent`
- `type` — Filter: `regular`, `plaintext`, `absplit`, `rss`, `variate`

**Response:**
```json
{
  "campaigns": [
    {
      "id": "abc123",
      "type": "regular",
      "status": "sent",
      "settings": {
        "subject_line": "June Newsletter",
        "from_name": "Acme Corp",
        "reply_to": "newsletter@acme.com"
      },
      "send_time": "2024-06-01T09:00:00+00:00",
      "report_summary": {
        "opens": 1234,
        "unique_opens": 987,
        "open_rate": 0.32,
        "clicks": 456,
        "subscriber_clicks": 321,
        "click_rate": 0.08
      }
    }
  ],
  "total_items": 25
}
```

### Get Campaign
`GET /campaigns/{campaignId}`

Returns details for a specific campaign.

### Create Campaign
`POST /campaigns`

Creates a new campaign.

**Request body (JSON):**
```json
{
  "type": "regular",
  "recipients": {
    "list_id": "abc123"
  },
  "settings": {
    "subject_line": "July Newsletter",
    "from_name": "Acme Corp",
    "reply_to": "newsletter@acme.com"
  }
}
```

### Send Campaign
`POST /campaigns/{campaignId}/actions/send`

Sends a campaign. The campaign must have content set and be in `save` status.

### Search Members
`GET /search-members`

Searches for members across all audiences.

**Query parameters:**
- `query` — Search query (email address or name)

**Response:**
```json
{
  "exact_matches": {
    "members": [
      {
        "id": "e4b19db0...",
        "email_address": "alice@example.com",
        "list_id": "abc123"
      }
    ],
    "total_items": 1
  },
  "full_search": {
    "members": [],
    "total_items": 0
  }
}
```

### List Tags
`GET /lists/{listId}/tag-search`

Search tags in an audience.

**Query parameters:**
- `name` — Tag name to search for

## Common Patterns

### Pagination
Offset-based pagination:
- Use `count` (page size) and `offset` (items to skip)
- Response includes `total_items` for total count
- Last page: `offset + count >= total_items`

### Subscriber Hash
Member endpoints use MD5 hash of the lowercase email as the identifier:
```
subscriberHash = MD5("alice@example.com")
```

### Data Center
The API base URL includes a data center prefix (e.g. `us21`). After OAuth, call:
```
GET https://login.mailchimp.com/oauth2/metadata
Authorization: Bearer {access_token}
```
Response includes `api_endpoint` (e.g. `https://us21.api.mailchimp.com`).

### Error Format
```json
{
  "type": "https://mailchimp.com/developer/marketing/docs/errors/",
  "title": "Resource Not Found",
  "status": 404,
  "detail": "The requested resource could not be found.",
  "instance": "abc123-def456"
}
```

## Important Notes
- **No refresh tokens** — Mailchimp access tokens are permanent and do not expire.
- **No scopes** — Mailchimp OAuth grants full API access (no granular permissions).
- **Data center prefix** — Must call the metadata endpoint to discover the correct API base URL after OAuth.
- Subscriber hash is MD5 of the **lowercase** email address.
- Member status values: `subscribed`, `unsubscribed`, `cleaned`, `pending`, `transactional`.
- Rate limit: 10 concurrent connections per user. No explicit rate limit, but excessive requests may be throttled.
- Merge fields (e.g. `FNAME`, `LNAME`) are configurable per audience.
