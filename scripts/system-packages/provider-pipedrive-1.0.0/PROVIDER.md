# Pipedrive API

Base URL: `https://api.pipedrive.com/v1`

Sales CRM and pipeline management platform. Manage deals, persons (contacts), organizations, activities, and leads. Responses are wrapped in `{ "success": true, "data": [...] }`. Custom fields use hash-based IDs.

## Endpoints

### Get Current User

`GET /users/me`

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 12345,
    "name": "John Doe",
    "email": "john@example.com",
    "default_currency": "USD",
    "language": { "language_code": "en" },
    "company_id": 9876
  }
}
```

### List Deals

`GET /deals`

**Query parameters:**

- `start` — Pagination offset (default 0)
- `limit` — Max results (default 100, max 500)
- `status` — `open`, `won`, `lost`, `deleted`, `all_not_deleted`
- `sort` — Field to sort by (e.g. `add_time DESC`)

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1001,
      "title": "Enterprise License Deal",
      "value": 50000,
      "currency": "USD",
      "status": "open",
      "stage_id": 3,
      "pipeline_id": 1,
      "person_id": 2001,
      "org_id": 3001,
      "add_time": "2024-01-15 09:30:00",
      "update_time": "2024-01-16 14:20:00",
      "expected_close_date": "2024-03-15"
    }
  ],
  "additional_data": {
    "pagination": {
      "start": 0,
      "limit": 100,
      "more_items_in_collection": true,
      "next_start": 100
    }
  }
}
```

### Get Deal

`GET /deals/{DEAL_ID}`

### Create Deal

`POST /deals`

**Request body (JSON):**

```json
{
  "title": "New Enterprise Deal",
  "value": 25000,
  "currency": "USD",
  "person_id": 2001,
  "org_id": 3001,
  "stage_id": 1,
  "expected_close_date": "2024-06-30"
}
```

### Update Deal

`PUT /deals/{DEAL_ID}`

**Request body (JSON):**

```json
{
  "status": "won",
  "value": 30000,
  "won_time": "2024-03-10 10:00:00"
}
```

### Delete Deal

`DELETE /deals/{DEAL_ID}`

### List Persons (Contacts)

`GET /persons`

**Query parameters:**

- `start`, `limit`, `sort`

### Get Person

`GET /persons/{PERSON_ID}`

### Create Person

`POST /persons`

**Request body (JSON):**

```json
{
  "name": "Jane Smith",
  "email": [{ "value": "jane@example.com", "primary": true }],
  "phone": [{ "value": "+1234567890", "primary": true }],
  "org_id": 3001
}
```

### Update Person

`PUT /persons/{PERSON_ID}`

### List Organizations

`GET /organizations`

**Query parameters:**

- `start`, `limit`, `sort`

### Create Organization

`POST /organizations`

**Request body (JSON):**

```json
{
  "name": "Acme Corporation",
  "address": "123 Main St, New York, NY"
}
```

### List Activities

`GET /activities`

**Query parameters:**

- `start`, `limit`
- `type` — Activity type (e.g. `call`, `meeting`, `email`)
- `done` — `0` (not done) or `1` (done)
- `user_id` — Filter by user

### Create Activity

`POST /activities`

**Request body (JSON):**

```json
{
  "subject": "Follow-up call",
  "type": "call",
  "due_date": "2024-02-20",
  "due_time": "14:00",
  "deal_id": 1001,
  "person_id": 2001,
  "note": "Discuss contract terms"
}
```

### List Leads

`GET /leads`

**Query parameters:**

- `start`, `limit`
- `sort` — `add_time ASC`, `update_time DESC`, etc.

### Create Lead

`POST /leads`

**Request body (JSON):**

```json
{
  "title": "Potential client from webinar",
  "person_id": 2001,
  "organization_id": 3001,
  "expected_close_date": "2024-04-30",
  "value": { "amount": 10000, "currency": "USD" }
}
```

### Search Items

`GET /itemSearch`

**Query parameters:**

- `term` — Search query
- `item_types` — Comma-separated: `deal`, `person`, `organization`, `product`, `lead`
- `start`, `limit`

**Response:**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "result_score": 0.95,
        "item": {
          "id": 2001,
          "type": "person",
          "title": "Jane Smith"
        }
      }
    ]
  }
}
```

### List Pipelines

`GET /pipelines`

### List Stages

`GET /stages`

**Query parameters:**

- `pipeline_id` — Filter by pipeline

## Common Patterns

### Pagination

Cursor-style with offset. Responses include `additional_data.pagination` with `more_items_in_collection` (boolean) and `next_start` (next offset). Pass `start={next_start}` for the next page.

### Custom Fields

Custom fields have hash IDs (e.g. `abc123def456`). Discover them with:

- `GET /dealFields` — Deal custom fields
- `GET /personFields` — Person custom fields
- `GET /organizationFields` — Organization custom fields

### Multi-value Fields

Email and phone fields are arrays of objects:

```json
{
  "email": [{ "value": "john@example.com", "primary": true, "label": "work" }]
}
```

### Error Format

```json
{
  "success": false,
  "error": "Deal not found",
  "error_info": "Please check the ID",
  "errorCode": 404
}
```

### Rate Limits

80 requests per 2 seconds per OAuth user. Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Returns 429 when exceeded.

## Important Notes

- **Token refresh** — Access tokens expire after 1 hour. Automatic refresh via the runtime.
- **Custom field IDs** — Custom fields use hash IDs, not human-readable names. Query the `*Fields` endpoints to get mappings.
- **Email/phone as arrays** — Contact email and phone are arrays of objects with `value`, `primary`, `label`.
- **Pipeline stages** — Deals progress through stages. Get available stages with `GET /stages?pipeline_id={ID}`.
- **Monetary values** — Deal values are in the deal's currency. Use `currency` field to know the unit.
- **API v2 migration** — Some endpoints are migrating to v2 (`/api/v2/`). Use v1 which is stable and complete.
