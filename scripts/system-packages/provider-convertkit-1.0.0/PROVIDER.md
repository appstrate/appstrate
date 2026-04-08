# ConvertKit (Kit) API

Base URL: `https://api.kit.com/v4`

Email marketing platform API for creators. Manage subscribers, forms, tags, email sequences, and broadcasts. ConvertKit has rebranded to "Kit" — the API lives at `api.kit.com`. No granular scopes — OAuth grants full access.

## Endpoints

### Get Account Info
`GET /account`

Returns the authenticated account's info.

**Response:**
```json
{
  "user": {
    "name": "John Doe",
    "primary_email_address": "john@example.com"
  },
  "account": {
    "name": "John's Newsletter",
    "plan_name": "Creator Pro",
    "primary_email_address": "newsletter@example.com",
    "subscriber_count": 12500
  }
}
```

### List Subscribers
`GET /subscribers`

Returns all subscribers.

**Query parameters:**
- `page` — Page number (1-indexed, default 1)
- `per_page` — Items per page (default 50, max 500)
- `status` — Filter: `active`, `cancelled`, `bounced`, `complained`
- `sort_field` — Sort by: `id`, `created_at`, `cancelled_at`
- `sort_order` — `asc` or `desc`
- `after` — Subscribers created after this date (ISO 8601)
- `before` — Subscribers created before this date
- `email_address` — Filter by exact email

**Response:**
```json
{
  "subscribers": [
    {
      "id": 12345,
      "first_name": "Alice",
      "email_address": "alice@example.com",
      "state": "active",
      "created_at": "2024-01-10T08:00:00.000Z",
      "fields": {
        "company": "Acme Corp",
        "role": "CTO"
      }
    }
  ],
  "pagination": {
    "has_previous_page": false,
    "has_next_page": true,
    "start_cursor": "eyJpZCI6MTIzNDV9",
    "end_cursor": "eyJpZCI6MTI0MDB9",
    "per_page": 50
  }
}
```

### Get Subscriber
`GET /subscribers/{subscriberId}`

Returns a single subscriber.

### Create Subscriber
`POST /subscribers`

Creates a new subscriber.

**Request body (JSON):**
```json
{
  "email_address": "bob@example.com",
  "first_name": "Bob",
  "fields": {
    "company": "Widgets Inc",
    "role": "Marketing"
  }
}
```

**Response:**
```json
{
  "subscriber": {
    "id": 12346,
    "first_name": "Bob",
    "email_address": "bob@example.com",
    "state": "active",
    "created_at": "2024-06-15T10:30:00.000Z"
  }
}
```

### Update Subscriber
`PUT /subscribers/{subscriberId}`

Updates a subscriber's info.

**Request body (JSON):**
```json
{
  "first_name": "Robert",
  "fields": {
    "company": "New Corp"
  }
}
```

### List Forms
`GET /forms`

Returns all opt-in forms and landing pages.

**Query parameters:**
- `page` — Page number
- `per_page` — Items per page
- `status` — Filter: `active`, `archived`, `trashed`, `all`
- `type` — Filter: `embed`, `hosted`, `modal`

**Response:**
```json
{
  "forms": [
    {
      "id": 456,
      "name": "Newsletter Signup",
      "type": "embed",
      "format": "inline",
      "embed_js": "https://app.kit.com/forms/456/embed.js",
      "embed_url": "https://app.kit.com/forms/456/embed",
      "archived": false,
      "uid": "abc123xyz",
      "title": "Join our newsletter",
      "description": "Get weekly tips",
      "created_at": "2024-01-15T10:00:00.000Z"
    }
  ],
  "pagination": {
    "has_previous_page": false,
    "has_next_page": false,
    "per_page": 50
  }
}
```

### List Form Subscribers
`GET /forms/{formId}/subscribers`

Returns subscribers who signed up through a specific form.

**Query parameters:**
- `page` — Page number
- `per_page` — Items per page
- `status` — `active`, `cancelled`

### Add Subscriber to Form
`POST /forms/{formId}/subscribers`

Subscribes an email to a form.

**Request body (JSON):**
```json
{
  "email_address": "alice@example.com",
  "first_name": "Alice"
}
```

### List Tags
`GET /tags`

Returns all tags.

**Response:**
```json
{
  "tags": [
    {
      "id": 789,
      "name": "VIP",
      "created_at": "2024-01-15T10:00:00.000Z"
    },
    {
      "id": 790,
      "name": "Webinar Attendee",
      "created_at": "2024-02-20T15:30:00.000Z"
    }
  ],
  "pagination": {
    "has_previous_page": false,
    "has_next_page": false,
    "per_page": 50
  }
}
```

### Tag Subscriber
`POST /tags/{tagId}/subscribers`

Adds a tag to a subscriber.

**Request body (JSON):**
```json
{
  "email_address": "alice@example.com"
}
```

### Remove Tag from Subscriber
`DELETE /tags/{tagId}/subscribers/{subscriberId}`

Removes a tag from a subscriber.

### List Sequences
`GET /sequences`

Returns all email sequences (automations).

**Response:**
```json
{
  "sequences": [
    {
      "id": 101,
      "name": "Welcome Series",
      "hold": false,
      "repeat": false,
      "created_at": "2024-01-15T10:00:00.000Z"
    }
  ],
  "pagination": {
    "has_previous_page": false,
    "has_next_page": false,
    "per_page": 50
  }
}
```

### List Broadcasts
`GET /broadcasts`

Returns all email broadcasts.

**Query parameters:**
- `page` — Page number
- `per_page` — Items per page
- `status` — Filter: `draft`, `scheduled`, `sent`

**Response:**
```json
{
  "broadcasts": [
    {
      "id": 201,
      "subject": "June Newsletter",
      "status": "sent",
      "created_at": "2024-06-01T08:00:00.000Z",
      "published_at": "2024-06-01T09:00:00.000Z",
      "send_at": "2024-06-01T09:00:00.000Z",
      "stats": {
        "recipients": 12500,
        "open_rate": 0.42,
        "click_rate": 0.08,
        "unsubscribes": 3
      }
    }
  ],
  "pagination": {
    "has_previous_page": false,
    "has_next_page": true,
    "per_page": 50
  }
}
```

## Common Patterns

### Pagination
Cursor-based pagination:
- Response includes `pagination.has_next_page` and `pagination.end_cursor`
- Pass `after` with the `end_cursor` value for the next page
- Also supports `page` and `per_page` parameters
- When `has_next_page` is `false`, no more pages

### Error Format
```json
{
  "errors": [
    "Subscriber not found"
  ]
}
```

## Important Notes
- **No scopes** — Kit OAuth grants full API access (no granular permissions).
- ConvertKit rebranded to **Kit** — the API is at `api.kit.com`, not `api.convertkit.com`.
- Access tokens expire after 2 hours; refresh tokens are long-lived.
- Subscriber identifiers: numeric ID or email address (some endpoints accept either).
- Subscriber states: `active`, `cancelled`, `bounced`, `complained`.
- Custom fields are defined per-account and returned in the `fields` object on subscribers.
- Rate limit: 120 requests per minute per account.
- The v4 API uses JSON request/response bodies (v3 used form-encoded for some endpoints).
