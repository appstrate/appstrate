# Airtable API

Base URL: `https://api.airtable.com/v0`

Low-code collaborative database platform. Each Airtable base contains tables with typed fields. Records are accessed via `/{BASE_ID}/{TABLE_ID_OR_NAME}`. You must first list bases to get the base ID, then list tables to discover field names.

## Endpoints

### Get Current User
`GET /v0/meta/whoami`

**Response:**
```json
{
  "id": "usrXYZ123",
  "email": "john@example.com",
  "scopes": ["data.records:read", "schema.bases:read"]
}
```

### List Bases
`GET /v0/meta/bases`

**Query parameters:**
- `offset` — Pagination cursor

**Response:**
```json
{
  "bases": [
    {
      "id": "appABC123",
      "name": "Project Tracker",
      "permissionLevel": "create"
    }
  ],
  "offset": "itrXYZ789"
}
```

### List Tables (Schema)
`GET /v0/meta/bases/{BASE_ID}/tables`

**Response:**
```json
{
  "tables": [
    {
      "id": "tblDEF456",
      "name": "Tasks",
      "fields": [
        { "id": "fldGHI789", "name": "Name", "type": "singleLineText" },
        { "id": "fldJKL012", "name": "Status", "type": "singleSelect", "options": { "choices": [{ "name": "Todo" }, { "name": "In Progress" }, { "name": "Done" }] } },
        { "id": "fldMNO345", "name": "Assignee", "type": "collaborator" },
        { "id": "fldPQR678", "name": "Due Date", "type": "date" },
        { "id": "fldSTU901", "name": "Priority", "type": "singleSelect" }
      ]
    }
  ]
}
```

### List Records
`GET /v0/{BASE_ID}/{TABLE_ID_OR_NAME}`

**Query parameters:**
- `fields[]` — Repeat for each field to include (e.g. `fields[]=Name&fields[]=Status`)
- `filterByFormula` — Airtable formula to filter (e.g. `AND({Status}='Active', {Priority}='High')`)
- `maxRecords` — Max total records to return
- `pageSize` — Records per page (max 100)
- `offset` — Pagination cursor from previous response
- `sort[0][field]` — Field name to sort by
- `sort[0][direction]` — `asc` or `desc`
- `view` — Name or ID of a view to filter/sort by

**Response:**
```json
{
  "records": [
    {
      "id": "recABC123",
      "createdTime": "2024-01-15T09:30:00.000Z",
      "fields": {
        "Name": "Design homepage",
        "Status": "In Progress",
        "Assignee": { "id": "usrXYZ", "email": "john@example.com", "name": "John Doe" },
        "Due Date": "2024-02-15",
        "Priority": "High",
        "Tags": ["frontend", "urgent"]
      }
    }
  ],
  "offset": "itrABC789/recDEF456"
}
```

### Get Record
`GET /v0/{BASE_ID}/{TABLE_ID_OR_NAME}/{RECORD_ID}`

### Create Records
`POST /v0/{BASE_ID}/{TABLE_ID_OR_NAME}`

Max 10 records per request.

**Request body (JSON):**
```json
{
  "records": [
    {
      "fields": {
        "Name": "New task",
        "Status": "Todo",
        "Due Date": "2024-03-01",
        "Priority": "Medium"
      }
    }
  ]
}
```

**Response:**
```json
{
  "records": [
    {
      "id": "recNEW123",
      "createdTime": "2024-02-01T10:00:00.000Z",
      "fields": {
        "Name": "New task",
        "Status": "Todo",
        "Due Date": "2024-03-01",
        "Priority": "Medium"
      }
    }
  ]
}
```

### Update Records
`PATCH /v0/{BASE_ID}/{TABLE_ID_OR_NAME}`

Max 10 records per request. Only specified fields are updated.

**Request body (JSON):**
```json
{
  "records": [
    {
      "id": "recABC123",
      "fields": {
        "Status": "Done",
        "Completed Date": "2024-02-10"
      }
    }
  ]
}
```

### Replace Records (Upsert)
`PUT /v0/{BASE_ID}/{TABLE_ID_OR_NAME}`

Replaces all fields. Unspecified fields are cleared.

### Delete Records
`DELETE /v0/{BASE_ID}/{TABLE_ID_OR_NAME}?records[]={RECORD_ID1}&records[]={RECORD_ID2}`

Max 10 records per request.

### List Comments
`GET /v0/{BASE_ID}/{TABLE_ID_OR_NAME}/{RECORD_ID}/comments`

**Query parameters:**
- `offset` — Pagination cursor
- `pageSize` — Max 100

### Add Comment
`POST /v0/{BASE_ID}/{TABLE_ID_OR_NAME}/{RECORD_ID}/comments`

**Request body (JSON):**
```json
{
  "text": "This task needs review before closing."
}
```

## Common Patterns

### Pagination
Offset-based. When more records exist, the response includes an `offset` string. Pass it as a query parameter to get the next page. Max `pageSize` is 100. When no `offset` in response, all records have been returned.

### filterByFormula
Airtable formula syntax for filtering:
- `{Status} = 'Active'`
- `AND({Status} = 'Active', {Priority} = 'High')`
- `OR({Status} = 'Todo', {Status} = 'In Progress')`
- `FIND('urgent', ARRAYJOIN({Tags}))` — search in array fields
- `IS_AFTER({Due Date}, TODAY())`
- `NOT({Completed})`

### Field Types
Common field types and their JSON representation:
- **singleLineText**: `"Hello world"`
- **singleSelect**: `"Option A"`
- **multipleSelects**: `["Option A", "Option B"]`
- **date**: `"2024-03-15"`
- **checkbox**: `true` / `false`
- **number**: `42`
- **collaborator**: `{ "id": "usrXYZ", "email": "...", "name": "..." }`
- **multipleRecordLinks**: `["recABC", "recDEF"]`
- **attachment**: `[{ "url": "https://..." }]`

### Error Format
```json
{
  "error": {
    "type": "INVALID_REQUEST_UNKNOWN",
    "message": "Could not find field 'invalid_field' in table 'Tasks'"
  }
}
```

### Rate Limits
5 requests per second per base. Returns 429 with `Retry-After` header. No rate limit headers on successful requests.

## Important Notes
- **Base ID required** — Every record operation requires the base ID (`appXXX`). Use `GET /v0/meta/bases` to discover bases.
- **Fields by name** — Records reference fields by name (case-sensitive), not by ID. Names can contain spaces.
- **Batch limit** — Max 10 records per create/update/delete request.
- **PKCE required** — Airtable OAuth requires PKCE (S256), which Appstrate handles automatically.
- **Token refresh** — Access tokens expire after 2 hours. Rotating refresh tokens (60-day inactivity expiry).
- **Table reference** — Tables can be referenced by name (URL-encoded) or ID (`tblXXX`). Prefer IDs for stability.
- **Formula syntax** — `filterByFormula` uses Airtable's formula language, similar to spreadsheet formulas.
