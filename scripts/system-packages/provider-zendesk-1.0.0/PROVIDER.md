# Zendesk API

Base URL: `https://{subdomain}.zendesk.com/api/v2`

Customer service and support ticketing platform. The subdomain is specific to each Zendesk account. All endpoints use the `.json` suffix. Authentication uses Basic HTTP with `email/token:api_token` (pre-encoded by the runtime).

## Endpoints

### Get Current User
`GET /api/v2/users/me.json`

**Response:**
```json
{
  "user": {
    "id": 12345,
    "name": "John Doe",
    "email": "john@example.com",
    "role": "admin",
    "active": true,
    "time_zone": "Europe/Paris",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

### List Tickets
`GET /api/v2/tickets.json`

**Query parameters:**
- `page` — Page number (starts at 1)
- `per_page` — Results per page (max 100)
- `sort_by` — `created_at`, `updated_at`, `priority`, `status`, `ticket_type`
- `sort_order` — `asc` or `desc`

**Response:**
```json
{
  "tickets": [
    {
      "id": 1001,
      "subject": "Can't access my account",
      "description": "I'm getting an error when trying to login...",
      "status": "open",
      "priority": "high",
      "type": "problem",
      "requester_id": 5001,
      "assignee_id": 12345,
      "group_id": 101,
      "organization_id": 8001,
      "tags": ["login", "urgent"],
      "created_at": "2024-02-01T10:00:00Z",
      "updated_at": "2024-02-01T14:30:00Z"
    }
  ],
  "count": 150,
  "next_page": "https://mycompany.zendesk.com/api/v2/tickets.json?page=2",
  "previous_page": null
}
```

### Get Ticket
`GET /api/v2/tickets/{TICKET_ID}.json`

**Query parameters:**
- `include` — Sideload: `users`, `organizations`, `groups`

### Create Ticket
`POST /api/v2/tickets.json`

**Request body (JSON):**
```json
{
  "ticket": {
    "subject": "Order not received",
    "comment": {
      "body": "I placed an order 5 days ago and haven't received it."
    },
    "requester": { "name": "Customer", "email": "customer@example.com" },
    "priority": "normal",
    "type": "problem",
    "tags": ["shipping"]
  }
}
```

**Response:**
```json
{
  "ticket": {
    "id": 1002,
    "subject": "Order not received",
    "status": "new",
    "priority": "normal",
    "created_at": "2024-02-15T09:00:00Z"
  }
}
```

### Update Ticket
`PUT /api/v2/tickets/{TICKET_ID}.json`

**Request body (JSON):**
```json
{
  "ticket": {
    "status": "solved",
    "priority": "high",
    "assignee_id": 12345,
    "comment": {
      "body": "Issue has been resolved. Please try again.",
      "public": true
    }
  }
}
```

### Delete Ticket
`DELETE /api/v2/tickets/{TICKET_ID}.json`

### List Ticket Comments
`GET /api/v2/tickets/{TICKET_ID}/comments.json`

**Response:**
```json
{
  "comments": [
    {
      "id": 99001,
      "type": "Comment",
      "body": "I can't login to my account",
      "public": true,
      "author_id": 5001,
      "created_at": "2024-02-01T10:00:00Z"
    }
  ]
}
```

### Add Comment (via Ticket Update)
Comments are added by updating the ticket with a `comment` field (see Update Ticket above).

### List Users
`GET /api/v2/users.json`

**Query parameters:**
- `page`, `per_page`
- `role` — `end-user`, `agent`, `admin`

### Create User
`POST /api/v2/users.json`

**Request body (JSON):**
```json
{
  "user": {
    "name": "Jane Smith",
    "email": "jane@example.com",
    "role": "end-user",
    "organization_id": 8001
  }
}
```

### List Organizations
`GET /api/v2/organizations.json`

### Get Organization
`GET /api/v2/organizations/{ORG_ID}.json`

### Search
`GET /api/v2/search.json`

**Query parameters:**
- `query` — Search query string

**Search query syntax:**
- `type:ticket status:open priority:high`
- `type:user role:agent`
- `type:organization name:Acme`
- `type:ticket assignee:john@example.com created>2024-01-01`

**Response:**
```json
{
  "results": [
    {
      "id": 1001,
      "result_type": "ticket",
      "subject": "Can't access my account",
      "status": "open",
      "priority": "high"
    }
  ],
  "count": 15,
  "next_page": null
}
```

### List Views
`GET /api/v2/views.json`

### Get Tickets from View
`GET /api/v2/views/{VIEW_ID}/tickets.json`

## Common Patterns

### Pagination
Offset-based: `page` + `per_page` (max 100). Response includes `next_page` URL (full URL) and `count`. When `next_page` is `null`, all results returned. Cursor-based also available with `page[after]` + `page[size]`.

### Sideloading
Use `include` parameter to sideload related data: `?include=users,organizations`. Sideloaded data appears as separate arrays in the response.

### Ticket Statuses
`new`, `open`, `pending`, `hold`, `solved`, `closed`

### Ticket Priorities
`low`, `normal`, `high`, `urgent`

### Ticket Types
`problem`, `incident`, `question`, `task`

### Error Format
```json
{
  "error": "RecordNotFound",
  "description": "Not found"
}
```

### Rate Limits
Depends on plan: Essential 10 rpm, Team 200 rpm, Professional 400 rpm, Enterprise 700 rpm. Headers: `X-Rate-Limit`, `X-Rate-Limit-Remaining`, `Retry-After`. Returns 429 when exceeded.

## Important Notes
- **Subdomain in URL** — Base URL includes the customer's subdomain. Use the `subdomain` credential field.
- **JSON suffix** — All endpoints require `.json` suffix. Without it, HTML may be returned.
- **Basic auth** — Authentication is pre-encoded as `base64(email/token:api_key)` by the runtime.
- **Token permanent** — API tokens don't expire unless manually revoked.
- **Comments via updates** — To add a comment, update the ticket with a `comment` object. There's no separate "create comment" endpoint.
- **Request wrapping** — Create/update requests wrap the body in the entity name (e.g. `{ "ticket": { ... } }`).
- **Search syntax** — The search endpoint uses a proprietary query syntax with `type:`, `status:`, `priority:`, etc.
