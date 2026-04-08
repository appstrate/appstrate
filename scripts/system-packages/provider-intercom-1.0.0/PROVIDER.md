# Intercom API

Base URL: `https://api.intercom.io`

Customer messaging platform API. Manage contacts, conversations, messages, tags, and articles. Specify API version via `Intercom-Version` header (current: `2.11`). Access tokens are permanent (no refresh needed).

## Endpoints

### Get Current Admin
`GET /me`

Returns the authenticated admin/teammate.

**Response:**
```json
{
  "type": "admin",
  "id": "12345",
  "name": "John Doe",
  "email": "john@example.com",
  "app": {
    "type": "app",
    "id_code": "abc123",
    "name": "Acme Corp",
    "timezone": "Europe/Paris"
  }
}
```

### List Contacts
`GET /contacts`

Returns contacts (customers and leads). Use search for filtered results.

**Query parameters:**
- `per_page` — Items per page (default 50, max 150)
- `starting_after` — Cursor for next page

**Response:**
```json
{
  "type": "list",
  "data": [
    {
      "type": "contact",
      "id": "634dd08015e4d411e4e2f8b6",
      "external_id": "cust_001",
      "email": "alice@example.com",
      "name": "Alice Martin",
      "role": "user",
      "created_at": 1718445600,
      "updated_at": 1718449200,
      "last_seen_at": 1718449000,
      "signed_up_at": 1718445600,
      "tags": {
        "type": "list",
        "data": [
          { "type": "tag", "id": "123", "name": "VIP" }
        ]
      },
      "custom_attributes": {
        "plan": "enterprise"
      }
    }
  ],
  "total_count": 5420,
  "pages": {
    "type": "pages",
    "page": 1,
    "per_page": 50,
    "total_pages": 109,
    "next": {
      "starting_after": "WzE2OTg0NTY4MDBd"
    }
  }
}
```

### Get Contact
`GET /contacts/{contactId}`

Returns a single contact by ID.

### Create Contact
`POST /contacts`

Creates a new contact.

**Request body (JSON):**
```json
{
  "role": "user",
  "email": "bob@example.com",
  "name": "Bob Wilson",
  "external_id": "cust_002",
  "custom_attributes": {
    "plan": "starter",
    "signup_source": "website"
  }
}
```

### Update Contact
`PUT /contacts/{contactId}`

Updates an existing contact.

**Request body (JSON):**
```json
{
  "name": "Bob Wilson Jr.",
  "custom_attributes": {
    "plan": "enterprise"
  }
}
```

### Delete Contact
`DELETE /contacts/{contactId}`

Permanently deletes a contact.

### Search Contacts
`POST /contacts/search`

Searches contacts with flexible query builder.

**Request body (JSON):**
```json
{
  "query": {
    "operator": "AND",
    "value": [
      {
        "field": "role",
        "operator": "=",
        "value": "user"
      },
      {
        "field": "email",
        "operator": "~",
        "value": "@example.com"
      }
    ]
  },
  "pagination": {
    "per_page": 25
  },
  "sort": {
    "field": "created_at",
    "order": "desc"
  }
}
```

### List Conversations
`GET /conversations`

Returns conversations.

**Query parameters:**
- `per_page` — Items per page (default 20, max 150)
- `starting_after` — Cursor for next page

**Response:**
```json
{
  "type": "conversation.list",
  "conversations": [
    {
      "type": "conversation",
      "id": "123456789",
      "title": "Help with billing",
      "created_at": 1718445600,
      "updated_at": 1718449200,
      "state": "open",
      "open": true,
      "read": true,
      "priority": "not_priority",
      "source": {
        "type": "conversation",
        "delivered_as": "customer_initiated"
      },
      "contacts": {
        "type": "contact.list",
        "contacts": [
          { "type": "contact", "id": "634dd080...", "external_id": "cust_001" }
        ]
      },
      "teammates": {
        "type": "admin.list",
        "admins": [
          { "type": "admin", "id": "12345", "name": "John Doe" }
        ]
      },
      "statistics": {
        "time_to_first_admin_reply": 120
      }
    }
  ],
  "pages": {
    "type": "pages",
    "per_page": 20,
    "total_pages": 15
  }
}
```

### Get Conversation
`GET /conversations/{conversationId}`

Returns a single conversation with full message history.

### Reply to Conversation
`POST /conversations/{conversationId}/reply`

Sends a reply in a conversation.

**Request body (JSON):**
```json
{
  "message_type": "comment",
  "type": "admin",
  "admin_id": "12345",
  "body": "<p>Thanks for reaching out! Let me look into this for you.</p>"
}
```

### Send Message
`POST /messages`

Sends a new outbound message to a contact.

**Request body (JSON):**
```json
{
  "message_type": "inapp",
  "body": "Welcome to our platform!",
  "from": {
    "type": "admin",
    "id": "12345"
  },
  "to": {
    "type": "user",
    "id": "634dd080..."
  }
}
```

### List Tags
`GET /tags`

Returns all tags in the workspace.

**Response:**
```json
{
  "type": "list",
  "data": [
    {
      "type": "tag",
      "id": "123",
      "name": "VIP"
    },
    {
      "type": "tag",
      "id": "456",
      "name": "Churning"
    }
  ]
}
```

### Tag Contact
`POST /contacts/{contactId}/tags`

Adds a tag to a contact.

**Request body (JSON):**
```json
{
  "id": "123"
}
```

### List Articles
`GET /articles`

Returns help center articles.

**Query parameters:**
- `per_page` — Items per page (default 50)
- `starting_after` — Cursor for next page

## Common Patterns

### Pagination
Cursor-based pagination:
- Response includes `pages.next.starting_after`
- Pass as `starting_after` query parameter
- When no `next` in `pages`, no more pages
- `per_page` controls page size

### Search Operators
Search query operators:
- `=` — Equals
- `!=` — Not equals
- `~` — Contains
- `!~` — Does not contain
- `>`, `<` — Greater/less than
- `AND`, `OR` — Combine conditions

### Error Format
```json
{
  "type": "error.list",
  "request_id": "abc123-def456",
  "errors": [
    {
      "code": "not_found",
      "message": "Contact not found"
    }
  ]
}
```

## Important Notes
- **No refresh tokens** — Intercom access tokens are permanent and never expire.
- **No scopes** — OAuth grants full API access (permissions managed at app level in Intercom).
- Include `Intercom-Version: 2.11` header for consistent API behavior across versions.
- Timestamps are Unix timestamps (seconds), not ISO 8601.
- Contact `role` values: `user` (customer) or `lead` (lead).
- Conversation `state` values: `open`, `closed`, `snoozed`.
- Rate limit: ~1000 API calls per minute per workspace.
- Search endpoints use POST with query body — not GET with query params.
- `external_id` is your own identifier for contacts, useful for syncing with other systems.
