# Freshsales API

Base URL: `https://{subdomain}.myfreshworks.com/crm/sales/api`

CRM platform for sales teams. The subdomain is specific to each Freshworks account. List endpoints use views (predefined filters) — you need a view ID to list records. Authentication uses the `Authorization: Token token={api_key}` header format.

## Endpoints

### List Contacts
`GET /contacts/view/{VIEW_ID}`

**Query parameters:**
- `page` — Page number (starts at 1)
- `per_page` — Results per page (max 100)
- `sort` — Sort field
- `sort_type` — `asc` or `desc`

**Response:**
```json
{
  "contacts": [
    {
      "id": 5001,
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "mobile_number": "+1234567890",
      "job_title": "CTO",
      "company": { "id": 8001, "name": "Acme Inc" },
      "lead_score": 85,
      "created_at": "2024-01-15T09:30:00Z",
      "updated_at": "2024-02-01T14:20:00Z"
    }
  ],
  "meta": {
    "total_pages": 5,
    "total": 245
  }
}
```

### Get Contact
`GET /contacts/{CONTACT_ID}`

**Response:**
```json
{
  "contact": {
    "id": 5001,
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "mobile_number": "+1234567890",
    "job_title": "CTO",
    "company": { "id": 8001, "name": "Acme Inc" },
    "lead_score": 85,
    "sales_accounts": [{ "id": 8001, "name": "Acme Inc" }],
    "deals": [{ "id": 3001, "name": "Enterprise License" }]
  }
}
```

### Create Contact
`POST /contacts`

**Request body (JSON):**
```json
{
  "contact": {
    "first_name": "Jane",
    "last_name": "Smith",
    "email": "jane@example.com",
    "mobile_number": "+1234567890",
    "job_title": "VP Engineering",
    "sales_account_id": 8001
  }
}
```

### Update Contact
`PUT /contacts/{CONTACT_ID}`

**Request body (JSON):**
```json
{
  "contact": {
    "job_title": "Senior VP Engineering",
    "mobile_number": "+0987654321"
  }
}
```

### Delete Contact
`DELETE /contacts/{CONTACT_ID}`

### List Leads
`GET /leads/view/{VIEW_ID}`

**Query parameters:**
- `page`, `per_page`, `sort`, `sort_type`

### Get Lead
`GET /leads/{LEAD_ID}`

### Create Lead
`POST /leads`

**Request body (JSON):**
```json
{
  "lead": {
    "first_name": "Jane",
    "last_name": "Doe",
    "email": "jane@prospect.com",
    "company": { "name": "Prospect Inc" },
    "medium": "Website",
    "deal": {
      "name": "New opportunity",
      "amount": 10000
    }
  }
}
```

### List Deals
`GET /deals/view/{VIEW_ID}`

**Query parameters:**
- `page`, `per_page`, `sort`, `sort_type`

### Get Deal
`GET /deals/{DEAL_ID}`

### Create Deal
`POST /deals`

**Request body (JSON):**
```json
{
  "deal": {
    "name": "Enterprise License Deal",
    "amount": 50000,
    "expected_close": "2024-06-30",
    "sales_account_id": 8001,
    "contacts_id": [5001]
  }
}
```

### Update Deal
`PUT /deals/{DEAL_ID}`

### Delete Deal
`DELETE /deals/{DEAL_ID}`

### List Sales Accounts
`GET /sales_accounts/view/{VIEW_ID}`

### Get Sales Account
`GET /sales_accounts/{ACCOUNT_ID}`

### Create Sales Account
`POST /sales_accounts`

**Request body (JSON):**
```json
{
  "sales_account": {
    "name": "Acme Corporation",
    "website": "https://acme.com",
    "phone": "+1234567890",
    "industry_type": { "name": "Technology" }
  }
}
```

### List Tasks
`GET /tasks`

**Query parameters:**
- `filter` — `open`, `completed`, `overdue`
- `page`, `per_page`

### Create Task
`POST /tasks`

**Request body (JSON):**
```json
{
  "task": {
    "title": "Follow up with client",
    "description": "Discuss contract terms",
    "due_date": "2024-03-15T10:00:00Z",
    "owner_id": 12345,
    "targetable_id": 5001,
    "targetable_type": "Contact"
  }
}
```

### List Notes
`GET /contacts/{CONTACT_ID}/notes`

### Add Note
`POST /contacts/{CONTACT_ID}/notes`

**Request body (JSON):**
```json
{
  "note": {
    "description": "Had a great call. Very interested in our enterprise plan."
  }
}
```

### Search
`GET /search`

**Query parameters:**
- `q` — Search query
- `include` — Entity types: `contact`, `lead`, `deal`, `sales_account`
- `page`, `per_page`

**Response:**
```json
{
  "contacts": [
    { "id": 5001, "first_name": "John", "last_name": "Doe", "email": "john@example.com" }
  ],
  "deals": [
    { "id": 3001, "name": "Enterprise License", "amount": 50000 }
  ]
}
```

## Common Patterns

### Views
List endpoints require a view ID (`/contacts/view/{VIEW_ID}`). Views are predefined filters. To discover available views, the default view ID is typically accessible from the Freshsales UI.

### Pagination
Page-based: `page` + `per_page` (max 100). Check `meta.total_pages` to know the total number of pages.

### Custom Fields
Custom fields use the `cf_` prefix (e.g. `cf_industry`, `cf_lead_source`). They appear as regular fields in responses.

### Request Wrapping
Create/update requests wrap the body in the entity name:
- `{ "contact": { ... } }`
- `{ "deal": { ... } }`
- `{ "lead": { ... } }`

### Error Format
```json
{
  "errors": {
    "message": ["Email has already been taken"]
  }
}
```

### Rate Limits
Depends on plan: Free 50/min, Growth 100/min, Pro 200/min. No standard rate limit headers. Returns 429 when exceeded.

## Important Notes
- **Subdomain in URL** — Base URL includes the customer's subdomain. Use the `subdomain` credential field.
- **Views required** — List endpoints need a view ID. There's no simple "list all" endpoint without a view.
- **Token format** — Uses `Authorization: Token token={api_key}` (Rails-style), not standard Bearer.
- **Token permanent** — API keys don't expire unless manually revoked.
- **Custom field prefix** — All custom fields have the `cf_` prefix in the API.
- **Two domains** — Some accounts use `.myfreshworks.com`, others use `.freshsales.io`. Both are supported.
- **Deal stages** — Deals progress through pipeline stages. Get available stages from the Freshsales UI.
