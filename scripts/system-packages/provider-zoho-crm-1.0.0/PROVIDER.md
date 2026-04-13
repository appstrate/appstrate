# Zoho CRM API

Base URL: `https://www.zohoapis.com/crm/v7`

CRM platform for sales and marketing. Uses a module-based REST API where all record operations follow the same pattern at `/crm/v7/{MODULE}`. The API domain may vary by datacenter region (`.com`, `.eu`, `.in`, `.com.au`, `.jp`). Uses `Zoho-oauthtoken` as the authorization header prefix instead of `Bearer`.

## Endpoints

### List Records
`GET /crm/v7/{MODULE}`

**Query parameters:**
- `fields` — Comma-separated field names (e.g. `Last_Name,Email,Phone`)
- `page` — Page number (starts at 1)
- `per_page` — Records per page (max 200)
- `sort_by` — Field to sort by
- `sort_order` — `asc` or `desc`

**Response:**
```json
{
  "data": [
    {
      "id": "5073207000002154001",
      "Last_Name": "Smith",
      "First_Name": "John",
      "Email": "john@example.com",
      "Phone": "+1234567890",
      "Created_Time": "2024-01-15T09:30:00+00:00",
      "Modified_Time": "2024-01-16T14:20:00+00:00"
    }
  ],
  "info": {
    "per_page": 200,
    "count": 200,
    "page": 1,
    "more_records": true
  }
}
```

### Get Record
`GET /crm/v7/{MODULE}/{RECORD_ID}`

### Create Records
`POST /crm/v7/{MODULE}`

**Request body (JSON):**
```json
{
  "data": [
    {
      "Last_Name": "Smith",
      "First_Name": "John",
      "Email": "john@example.com",
      "Phone": "+1234567890",
      "Company": "Acme Inc"
    }
  ]
}
```

**Response:**
```json
{
  "data": [
    {
      "code": "SUCCESS",
      "details": { "id": "5073207000002154001", "Created_Time": "2024-01-15T09:30:00+00:00" },
      "message": "record added",
      "status": "success"
    }
  ]
}
```

### Update Records
`PUT /crm/v7/{MODULE}`

**Request body (JSON):**
```json
{
  "data": [
    {
      "id": "5073207000002154001",
      "Phone": "+0987654321",
      "Company": "New Company"
    }
  ]
}
```

### Delete Records
`DELETE /crm/v7/{MODULE}?ids={ID1},{ID2}`

### Search Records
`GET /crm/v7/{MODULE}/search`

**Query parameters:**
- `criteria` — Filter criteria (e.g. `(Last_Name:equals:Smith)`)
- `email` — Search by email
- `phone` — Search by phone
- `word` — Search by keyword
- `page`, `per_page`

**Criteria operators:** `equals`, `starts_with`, `contains`, `not_equal`, `greater_than`, `less_than`, `greater_equal`, `less_equal`, `between`, `in`

### COQL Query
`POST /crm/v7/coql`

**Request body (JSON):**
```json
{
  "select_query": "select Last_Name, Email, Phone from Contacts where Lead_Source = 'Web' limit 10"
}
```

**Response:**
```json
{
  "data": [
    {
      "Last_Name": "Smith",
      "Email": "john@example.com",
      "Phone": "+1234567890"
    }
  ],
  "info": { "count": 10, "more_records": false }
}
```

### List Users
`GET /crm/v7/users`

**Query parameters:**
- `type` — `AllUsers`, `ActiveUsers`, `DeactiveUsers`, `AdminUsers`

### Get Notes
`GET /crm/v7/{MODULE}/{RECORD_ID}/Notes`

### Add Note
`POST /crm/v7/{MODULE}/{RECORD_ID}/Notes`

**Request body (JSON):**
```json
{
  "data": [
    {
      "Note_Title": "Follow-up call",
      "Note_Content": "Discussed pricing options. Will send proposal by Friday."
    }
  ]
}
```

### Get Related Records
`GET /crm/v7/{MODULE}/{RECORD_ID}/{RELATED_MODULE}`

Example: `GET /crm/v7/Accounts/5073207.../Contacts` — get contacts linked to an account.

## Common Patterns

### Modules
Standard modules: `Leads`, `Contacts`, `Accounts`, `Deals`, `Tasks`, `Events`, `Calls`, `Products`, `Quotes`, `Sales_Orders`, `Invoices`, `Campaigns`, `Notes`

### Pagination
Page-based: `page` (starts at 1) + `per_page` (max 200). Check `info.more_records` to know if there are more pages.

### Batch Operations
POST and PUT accept an array of up to 100 records in the `data` field.

### Error Format
```json
{
  "data": [
    {
      "code": "MANDATORY_NOT_FOUND",
      "details": { "api_name": "Last_Name" },
      "message": "required field not found",
      "status": "error"
    }
  ]
}
```

### Rate Limits
100 requests per minute (Standard plan). Header `X-RATELIMIT-REMAINING` shows remaining requests. Returns 429 when exceeded.

## Important Notes
- **Authorization prefix** — Uses `Zoho-oauthtoken` instead of `Bearer` in the Authorization header.
- **Multi-datacenter** — API domain varies by region: `.com` (US), `.eu` (EU), `.in` (India), `.com.au` (Australia), `.jp` (Japan).
- **Token refresh** — Access tokens expire after 1 hour. Automatic refresh via the runtime.
- **Scope separator** — Zoho uses commas to separate scopes (e.g. `ZohoCRM.modules.READ,ZohoCRM.users.READ`).
- **Field names** — Use underscore-separated PascalCase (e.g. `Last_Name`, `Lead_Source`, `Created_Time`).
- **Batch limit** — Max 100 records per create/update request.
- **COQL** — SQL-like query language as an alternative to the criteria-based search endpoint.
