# HubSpot API

Base URL: `https://api.hubapi.com`

## Quick Reference

CRM and marketing platform API. Manage contacts, companies, deals, and marketing content.
Uses the CRM v3 API for object operations.

## Key Endpoints

### List Contacts
GET /crm/v3/objects/contacts
List all contacts with properties.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/contacts?limit=10&properties=firstname,lastname,email" \
  -H "Authorization: Bearer {{token}}"
```

### Get Contact
GET /crm/v3/objects/contacts/{contactId}
Get a specific contact by ID.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/contacts/{CONTACT_ID}?properties=firstname,lastname,email,phone" \
  -H "Authorization: Bearer {{token}}"
```

### Create Contact
POST /crm/v3/objects/contacts
Create a new contact.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/contacts" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"email": "user@example.com", "firstname": "John", "lastname": "Doe", "phone": "+1234567890"}}'
```

### Update Contact
PATCH /crm/v3/objects/contacts/{contactId}
Update contact properties.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X PATCH \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/contacts/{CONTACT_ID}" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"properties": {"phone": "+0987654321", "company": "Acme Inc"}}'
```

### Search Contacts
POST /crm/v3/objects/contacts/search
Search contacts using filters and query.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" -X POST \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/contacts/search" \
  -H "Authorization: Bearer {{token}}" \
  -H "Content-Type: application/json" \
  -d '{"filterGroups": [{"filters": [{"propertyName": "email", "operator": "CONTAINS_TOKEN", "value": "example.com"}]}], "properties": ["firstname", "lastname", "email"], "limit": 10}'
```

### List Companies
GET /crm/v3/objects/companies
List all companies.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/companies?limit=10&properties=name,domain,industry" \
  -H "Authorization: Bearer {{token}}"
```

### List Deals
GET /crm/v3/objects/deals
List all deals.

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/deals?limit=10&properties=dealname,amount,dealstage,closedate" \
  -H "Authorization: Bearer {{token}}"
```

### Get Associations
GET /crm/v3/objects/{objectType}/{objectId}/associations/{toObjectType}
Get associated objects (e.g., contacts linked to a company).

**Example:**
```bash
curl -s "$SIDECAR_URL/proxy" \
  -H "X-Provider: hubspot" \
  -H "X-Target: https://api.hubapi.com/crm/v3/objects/companies/{COMPANY_ID}/associations/contacts" \
  -H "Authorization: Bearer {{token}}"
```

## Common Patterns

### Pagination
Responses include `paging.next.after` cursor. Pass as `after` query param.
Max `limit` is 100.

### Properties
Always specify `properties` parameter to choose which fields to return.
Without it, only `id` and `createdAt`/`updatedAt` are returned.

### Search Filter Operators
`EQ`, `NEQ`, `LT`, `LTE`, `GT`, `GTE`, `CONTAINS_TOKEN`, `NOT_CONTAINS_TOKEN`, `HAS_PROPERTY`, `NOT_HAS_PROPERTY`

### CRM Object Types
All follow the same CRUD pattern at `/crm/v3/objects/{type}`:
`contacts`, `companies`, `deals`, `tickets`, `products`, `line_items`, `quotes`

## Important Notes

- Rate limit: 100 requests per 10 seconds (private apps), 200/10s (OAuth).
- Properties are case-sensitive and use internal names (not display names).
- Search API has a 10,000 result limit.
- Batch endpoints available: `/crm/v3/objects/{type}/batch/create`, `batch/update`, `batch/read`.
- Associations connect objects: contacts <-> companies <-> deals <-> tickets.