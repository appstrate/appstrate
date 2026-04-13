# Salesforce API

Base URL: `https://{instance_url}/services/data/v62.0`

Cloud-based CRM platform. The base URL is instance-specific — after OAuth, use the `instance_url` from the token response (e.g. `https://mycompany.my.salesforce.com`). Uses SOQL for queries and a generic SObject CRUD pattern for all record types.

## Endpoints

### Get User Info
`GET https://{instance_url}/services/oauth2/userinfo`

**Response:**
```json
{
  "sub": "005xx000001Sv6eAAC",
  "name": "John Doe",
  "email": "john@example.com",
  "organization_id": "00Dxx0000001gEREAY",
  "preferred_username": "john@mycompany.com"
}
```

### List SObject Types
`GET /sobjects`

Returns all available object types (Contact, Account, Lead, Opportunity, etc.).

### Describe SObject
`GET /sobjects/{SOBJECT_TYPE}/describe`

Returns metadata: fields, field types, picklist values, relationships.

### Query Records (SOQL)
`GET /query?q={SOQL_QUERY}`

**Query parameters:**
- `q` — URL-encoded SOQL query

**Example:** `GET /query?q=SELECT+Id,Name,Email+FROM+Contact+WHERE+AccountId='001xx000003DGQYAA4'+LIMIT+10`

**Response:**
```json
{
  "totalSize": 3,
  "done": true,
  "records": [
    {
      "attributes": { "type": "Contact", "url": "/services/data/v62.0/sobjects/Contact/003xx000004TmiQAAS" },
      "Id": "003xx000004TmiQAAS",
      "Name": "John Doe",
      "Email": "john@example.com"
    }
  ]
}
```

When `done` is `false`, use `nextRecordsUrl` to fetch the next batch:
`GET {nextRecordsUrl}`

### Get Record
`GET /sobjects/{SOBJECT_TYPE}/{RECORD_ID}`

**Query parameters:**
- `fields` — Comma-separated field names (e.g. `Id,Name,Email,Phone`)

### Create Record
`POST /sobjects/{SOBJECT_TYPE}`

**Request body (JSON):**
```json
{
  "FirstName": "Jane",
  "LastName": "Smith",
  "Email": "jane@example.com",
  "Phone": "+1234567890",
  "AccountId": "001xx000003DGQYAA4"
}
```

**Response:**
```json
{
  "id": "003xx000004TmiRAAS",
  "success": true,
  "errors": []
}
```

### Update Record
`PATCH /sobjects/{SOBJECT_TYPE}/{RECORD_ID}`

**Request body (JSON):**
```json
{
  "Phone": "+0987654321",
  "Title": "Senior Developer"
}
```

Returns 204 No Content on success.

### Delete Record
`DELETE /sobjects/{SOBJECT_TYPE}/{RECORD_ID}`

Returns 204 No Content on success.

### Search (SOSL)
`GET /search?q=FIND+{searchTerm}+IN+ALL+FIELDS+RETURNING+Contact(Id,Name,Email),Account(Id,Name)`

**Response:**
```json
{
  "searchRecords": [
    {
      "attributes": { "type": "Contact" },
      "Id": "003xx000004TmiQAAS",
      "Name": "John Doe",
      "Email": "john@example.com"
    }
  ]
}
```

### Composite Request
`POST /composite`

Execute multiple operations in a single request.

**Request body (JSON):**
```json
{
  "compositeRequest": [
    {
      "method": "GET",
      "url": "/services/data/v62.0/sobjects/Account/001xx000003DGQYAA4",
      "referenceId": "refAccount"
    },
    {
      "method": "GET",
      "url": "/services/data/v62.0/query?q=SELECT+Id,Name+FROM+Contact+WHERE+AccountId='001xx000003DGQYAA4'",
      "referenceId": "refContacts"
    }
  ]
}
```

## Common Patterns

### SOQL (Salesforce Object Query Language)
SQL-like language for querying records:
- `SELECT Id, Name, Email FROM Contact WHERE AccountId = '001...'`
- `SELECT Id, Name, Amount, StageName FROM Opportunity WHERE CloseDate = THIS_MONTH`
- `SELECT Id, Name FROM Account WHERE Name LIKE '%Acme%' ORDER BY CreatedDate DESC LIMIT 25`
- `SELECT Id, Name, (SELECT Id, LastName FROM Contacts) FROM Account` — subquery for child records

### Standard SObject Types
All follow the same CRUD pattern at `/sobjects/{TYPE}`:
`Account`, `Contact`, `Lead`, `Opportunity`, `Case`, `Task`, `Event`, `Note`, `Campaign`, `Product2`, `Pricebook2`, `Order`

### Pagination
SOQL queries return max 2000 records per batch. When `done` is `false`, follow `nextRecordsUrl`. Example: `/services/data/v62.0/query/01gxx00000AAAAAAA-2000`.

### Error Format
```json
[
  {
    "message": "Session expired or invalid",
    "errorCode": "INVALID_SESSION_ID"
  }
]
```

### Rate Limits
Based on Salesforce edition. Enterprise: 100,000 API calls per 24 hours. Header `Sforce-Limit-Info: api-usage=25/100000` shows current usage.

## Important Notes
- **Instance URL** — The base URL is dynamic per organization. Use the `instance_url` from the OAuth token response.
- **Token refresh** — Access tokens expire after ~2 hours. Automatic refresh via the runtime.
- **SOQL required** — There's no generic "list all" endpoint. Use SOQL queries to retrieve records.
- **Field names** — Salesforce uses PascalCase field names (e.g. `FirstName`, `LastName`, `AccountId`).
- **Record IDs** — 15 or 18 character case-insensitive alphanumeric IDs (e.g. `003xx000004TmiQAAS`).
- **Sandbox** — Sandbox environments use `https://test.salesforce.com`. Only production is supported by default.
- **API version** — The version `v62.0` is in all paths. This is the current stable version.
