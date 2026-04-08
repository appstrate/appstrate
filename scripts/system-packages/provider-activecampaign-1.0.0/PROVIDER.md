# ActiveCampaign Provider

Base URL: `https://{account_name}.api-us1.com/api/3`

Replace `{account_name}` with the account subdomain from the connection credentials.

## Authentication

The API key is sent via the `Api-Token` header (injected automatically by the sidecar). This is NOT a Bearer token — ActiveCampaign uses a custom header name.

## Key Endpoints

### List Contacts

```
GET /api/3/contacts
```

Supports `?limit=20&offset=0`, `?search=email@example.com`, `?email=`, `?listid=`.

### Get Contact

```
GET /api/3/contacts/{contactId}
```

### Create Contact

```
POST /api/3/contacts
Content-Type: application/json

{
  "contact": {
    "email": "john@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "phone": "+1234567890"
  }
}
```

### Update Contact

```
PUT /api/3/contacts/{contactId}
Content-Type: application/json

{
  "contact": { "firstName": "Jane" }
}
```

### Delete Contact

```
DELETE /api/3/contacts/{contactId}
```

### List Deals

```
GET /api/3/deals
```

Supports `?filters[stage]=`, `?filters[owner]=`, `?orders[value]=ASC`.

### Create Deal

```
POST /api/3/deals
Content-Type: application/json

{
  "deal": {
    "title": "New Deal",
    "value": 10000,
    "currency": "usd",
    "group": "{pipelineId}",
    "stage": "{stageId}",
    "owner": "{ownerId}",
    "contact": "{contactId}"
  }
}
```

### List Campaigns

```
GET /api/3/campaigns
```

### List Mailing Lists

```
GET /api/3/lists
```

### Subscribe Contact to List

```
POST /api/3/contactLists
Content-Type: application/json

{
  "contactList": {
    "list": "{listId}",
    "contact": "{contactId}",
    "status": 1
  }
}
```

Status: `1` = subscribed, `2` = unsubscribed.

### List Automations

```
GET /api/3/automations
```

## Notes

- Pagination uses `offset` and `limit` query parameters (not page-based)
- Rate limit: 5 requests per second
- All create/update request bodies wrap the resource in a root key (e.g. `{ "contact": { ... } }`)
- Deal values are in cents (e.g. `10000` = $100.00)
- Contact tags managed via separate `/api/3/contactTags` endpoint
