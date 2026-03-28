# HubSpot API

Base URL: `https://api.hubapi.com`

CRM and marketing platform API. Manage contacts, companies, deals, and marketing content. Uses the CRM v3 API for object operations.

## Endpoints

### List Contacts
`GET /crm/v3/objects/contacts`

**Query parameters:**
- `limit` — max 100
- `after` — pagination cursor
- `properties` — comma-separated property names (e.g. `firstname,lastname,email`)

**Response:**
```json
{
  "results": [
    {
      "id": "123",
      "properties": {
        "firstname": "John",
        "lastname": "Doe",
        "email": "john@example.com"
      },
      "createdAt": "2024-01-15T09:30:00Z",
      "updatedAt": "2024-01-16T10:00:00Z"
    }
  ],
  "paging": {
    "next": { "after": "cursor-value" }
  }
}
```

### Get Contact
`GET /crm/v3/objects/contacts/{CONTACT_ID}`

**Query parameters:**
- `properties` — comma-separated property names

### Create Contact
`POST /crm/v3/objects/contacts`

**Request body:**
```json
{
  "properties": {
    "email": "user@example.com",
    "firstname": "John",
    "lastname": "Doe",
    "phone": "+1234567890"
  }
}
```

### Update Contact
`PATCH /crm/v3/objects/contacts/{CONTACT_ID}`

**Request body:**
```json
{
  "properties": {
    "phone": "+0987654321",
    "company": "Acme Inc"
  }
}
```

### Search Contacts
`POST /crm/v3/objects/contacts/search`

**Request body:**
```json
{
  "filterGroups": [
    {
      "filters": [
        {
          "propertyName": "email",
          "operator": "CONTAINS_TOKEN",
          "value": "example.com"
        }
      ]
    }
  ],
  "properties": ["firstname", "lastname", "email"],
  "limit": 10
}
```

### List Companies
`GET /crm/v3/objects/companies`

**Query parameters:**
- `limit`, `after`, `properties` (e.g. `name,domain,industry`)

### List Deals
`GET /crm/v3/objects/deals`

**Query parameters:**
- `limit`, `after`, `properties` (e.g. `dealname,amount,dealstage,closedate`)

### Get Associations
`GET /crm/v3/objects/{OBJECT_TYPE}/{OBJECT_ID}/associations/{TO_OBJECT_TYPE}`

Get associated objects (e.g. contacts linked to a company).

## Common Patterns

### Pagination
Responses include `paging.next.after` cursor. Pass as `after` query param. Max `limit` is 100.

### Properties
Always specify the `properties` parameter to choose which fields to return. Without it, only `id` and `createdAt`/`updatedAt` are returned.

### Search Filter Operators
`EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE`, `BETWEEN`, `IN`, `NOT_IN`, `CONTAINS_TOKEN`, `NOT_CONTAINS_TOKEN`, `HAS_PROPERTY`, `NOT_HAS_PROPERTY`

### CRM Object Types
All follow the same CRUD pattern at `/crm/v3/objects/{TYPE}`:
`contacts`, `companies`, `deals`, `tickets`, `products`, `line_items`, `quotes`, `tasks`, `notes`, `calls`, `emails`, `meetings`

### Batch Operations
Available at `/crm/v3/objects/{TYPE}/batch/create`, `batch/update`, `batch/read`, `batch/archive`.

## Important Notes

- Rate limit: 100/10s (Free/Starter private apps), 190/10s (Pro/Enterprise private apps), 110/10s (OAuth public apps).
- Properties are case-sensitive and use internal names (not display names).
- Search API has a 10,000 result limit. Max 5 filter groups, 6 filters per group, 18 filters total. Search-specific rate limit: 5 requests/second.
- Associations connect objects: contacts <-> companies <-> deals <-> tickets.
