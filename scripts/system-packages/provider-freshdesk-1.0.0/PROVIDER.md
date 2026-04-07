# Freshdesk API

Base URL: `https://{subdomain}.freshdesk.com/api/v2`

Customer support and helpdesk platform. The subdomain is specific to each Freshdesk account. Authentication uses Basic HTTP with the API key as username and `X` as password (pre-encoded by the runtime). Responses are returned directly without a wrapper envelope.

## Endpoints

### Get Current Agent
`GET /api/v2/agents/me`

**Response:**
```json
{
  "id": 12345,
  "contact": {
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890"
  },
  "type": "support_agent",
  "language": "en",
  "created_at": "2024-01-01T00:00:00Z"
}
```

### List Tickets
`GET /api/v2/tickets`

**Query parameters:**
- `page` — Page number (starts at 1)
- `per_page` — Results per page (max 100, default 30)
- `filter` — Predefined filter: `new_and_my_open`, `watching`, `spam`, `deleted`
- `order_by` — Sort field: `created_at`, `due_by`, `updated_at`
- `order_type` — `asc` or `desc`
- `include` — Sideload: `requester`, `company`, `stats`

**Response:**
```json
[
  {
    "id": 1001,
    "subject": "Can't login to my account",
    "description_text": "I'm getting an error when trying to login...",
    "status": 2,
    "priority": 3,
    "source": 1,
    "type": "Problem",
    "requester_id": 5001,
    "responder_id": 12345,
    "company_id": 8001,
    "group_id": 101,
    "tags": ["login", "urgent"],
    "created_at": "2024-02-01T10:00:00Z",
    "updated_at": "2024-02-01T14:30:00Z",
    "due_by": "2024-02-02T10:00:00Z"
  }
]
```

### Get Ticket
`GET /api/v2/tickets/{TICKET_ID}`

**Query parameters:**
- `include` — `conversations`, `requester`, `company`, `stats`

### Create Ticket
`POST /api/v2/tickets`

**Request body (JSON):**
```json
{
  "subject": "Order not received",
  "description": "I placed an order 5 days ago and haven't received it yet.",
  "email": "customer@example.com",
  "priority": 2,
  "status": 2,
  "type": "Problem",
  "tags": ["shipping", "order"]
}
```

**Response:**
```json
{
  "id": 1002,
  "subject": "Order not received",
  "status": 2,
  "priority": 2,
  "created_at": "2024-02-15T09:00:00Z"
}
```

### Update Ticket
`PUT /api/v2/tickets/{TICKET_ID}`

**Request body (JSON):**
```json
{
  "status": 4,
  "priority": 1,
  "responder_id": 12345
}
```

### Delete Ticket
`DELETE /api/v2/tickets/{TICKET_ID}`

### List Ticket Conversations
`GET /api/v2/tickets/{TICKET_ID}/conversations`

### Reply to Ticket
`POST /api/v2/tickets/{TICKET_ID}/reply`

**Request body (JSON):**
```json
{
  "body": "<p>Thank you for reaching out. We're looking into this issue.</p>"
}
```

### Add Note to Ticket
`POST /api/v2/tickets/{TICKET_ID}/notes`

**Request body (JSON):**
```json
{
  "body": "Internal note: Customer is a premium subscriber.",
  "private": true
}
```

### List Contacts
`GET /api/v2/contacts`

**Query parameters:**
- `page`, `per_page`
- `email` — Filter by exact email
- `phone` — Filter by phone

### Get Contact
`GET /api/v2/contacts/{CONTACT_ID}`

### Create Contact
`POST /api/v2/contacts`

**Request body (JSON):**
```json
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "+1234567890",
  "company_id": 8001
}
```

### List Companies
`GET /api/v2/companies`

### Create Company
`POST /api/v2/companies`

**Request body (JSON):**
```json
{
  "name": "Acme Corporation",
  "domains": ["acme.com"],
  "description": "Enterprise customer"
}
```

### Search Tickets
`GET /api/v2/search/tickets`

**Query parameters:**
- `query` — Search query string (e.g. `"status:2 AND priority:4"`)

**Response:**
```json
{
  "total": 15,
  "results": [
    {
      "id": 1001,
      "subject": "Login issue",
      "status": 2,
      "priority": 4
    }
  ]
}
```

### List Agents
`GET /api/v2/agents`

## Common Patterns

### Pagination
Page-based: `page` (starts at 1) + `per_page` (max 100). Response header `Link` with `rel="next"` indicates more pages. No `total` in the response body.

### Status Codes
- `2` — Open
- `3` — Pending
- `4` — Resolved
- `5` — Closed

### Priority Codes
- `1` — Low
- `2` — Medium
- `3` — High
- `4` — Urgent

### Source Codes
- `1` — Email
- `2` — Portal
- `3` — Phone
- `7` — Chat
- `9` — Feedback Widget
- `10` — Outbound Email

### Search Query Syntax
`"status:2 AND priority:4 AND created_at:>'2024-01-01'"`

Supported fields: `status`, `priority`, `type`, `tag`, `requester`, `company`, `agent`, `group`, `created_at`, `updated_at`, `due_by`

### Error Format
```json
{
  "description": "Validation failed",
  "errors": [
    {
      "field": "email",
      "message": "It should be a valid email address.",
      "code": "invalid_value"
    }
  ]
}
```

### Rate Limits
Depends on plan: Free 50/min, Growth 200/min, Pro 400/min, Enterprise 700/min. Headers: `X-RateLimit-Total`, `X-RateLimit-Remaining`, `X-RateLimit-Used-CurrentRequest`. Returns 429 when exceeded.

## Important Notes
- **Subdomain in URL** — The base URL includes the customer's subdomain. Use the `subdomain` credential field to build URLs.
- **No response envelope** — Responses return data directly (arrays or objects), not wrapped in a `data` field.
- **Numeric status/priority** — Statuses and priorities are numeric codes, not strings. See mappings above.
- **HTML in replies** — Reply and note bodies use HTML format.
- **Token permanent** — API keys don't expire unless manually revoked.
- **Basic auth** — Authentication is pre-encoded as `base64(api_key:X)` by the runtime.
