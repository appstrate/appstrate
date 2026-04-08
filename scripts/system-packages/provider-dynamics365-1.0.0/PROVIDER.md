# Microsoft Dynamics 365 API

Base URL: `https://{org}.api.crm.dynamics.com/api/data/v9.2`

Enterprise CRM and ERP platform. The base URL is organization-specific. Uses OData v4 protocol with standard query options (`$select`, `$filter`, `$expand`, `$orderby`, `$top`). Entity IDs are GUIDs. OAuth is also organization-specific in practice: the delegated scope should match the environment URL (for example `https://{org}.api.crm.dynamics.com/user_impersonation`).

## Endpoints

### WhoAmI
`GET /api/data/v9.2/WhoAmI`

**Response:**
```json
{
  "BusinessUnitId": "00000000-0000-0000-0000-000000000001",
  "UserId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "OrganizationId": "11111111-2222-3333-4444-555555555555"
}
```

### List Contacts
`GET /api/data/v9.2/contacts`

**Query parameters:**
- `$select` — Fields to return (e.g. `firstname,lastname,emailaddress1,telephone1`)
- `$filter` — OData filter (e.g. `statecode eq 0 and contains(lastname,'Smith')`)
- `$orderby` — Sort (e.g. `createdon desc`)
- `$top` — Max records (max 5000)
- `$expand` — Related entities (e.g. `parentcustomerid_account($select=name)`)
- `$count` — Include total count (`true`)

**Response:**
```json
{
  "@odata.context": "https://myorg.api.crm.dynamics.com/api/data/v9.2/$metadata#contacts",
  "value": [
    {
      "contactid": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "firstname": "John",
      "lastname": "Smith",
      "emailaddress1": "john@example.com",
      "telephone1": "+1234567890",
      "createdon": "2024-01-15T09:30:00Z",
      "_parentcustomerid_value": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
    }
  ],
  "@odata.nextLink": "https://myorg.api.crm.dynamics.com/api/data/v9.2/contacts?$skiptoken=..."
}
```

### Get Contact
`GET /api/data/v9.2/contacts({CONTACT_ID})`

**Query parameters:**
- `$select` — Fields to return
- `$expand` — Related entities

### Create Contact
`POST /api/data/v9.2/contacts`

**Request body (JSON):**
```json
{
  "firstname": "Jane",
  "lastname": "Smith",
  "emailaddress1": "jane@example.com",
  "telephone1": "+1234567890",
  "parentcustomerid_account@odata.bind": "/accounts(b2c3d4e5-f6a7-8901-bcde-f12345678901)"
}
```

Returns 204 with `OData-EntityId` header containing the new record URL.

### Update Contact
`PATCH /api/data/v9.2/contacts({CONTACT_ID})`

**Request body (JSON):**
```json
{
  "telephone1": "+0987654321",
  "jobtitle": "Senior Developer"
}
```

### Delete Contact
`DELETE /api/data/v9.2/contacts({CONTACT_ID})`

### List Accounts
`GET /api/data/v9.2/accounts`

**Query parameters:**
- `$select` — e.g. `name,revenue,industrycode,telephone1`
- `$filter`, `$orderby`, `$top`, `$expand`

### Create Account
`POST /api/data/v9.2/accounts`

**Request body (JSON):**
```json
{
  "name": "Acme Corporation",
  "telephone1": "+1234567890",
  "websiteurl": "https://acme.com",
  "revenue": 5000000
}
```

### List Leads
`GET /api/data/v9.2/leads`

**Query parameters:**
- `$select` — e.g. `subject,firstname,lastname,emailaddress1,companyname`
- `$filter` — e.g. `statecode eq 0` (open leads)

### Create Lead
`POST /api/data/v9.2/leads`

**Request body (JSON):**
```json
{
  "subject": "Potential enterprise client",
  "firstname": "Jane",
  "lastname": "Doe",
  "emailaddress1": "jane@prospect.com",
  "companyname": "Prospect Inc",
  "telephone1": "+1234567890"
}
```

### List Opportunities
`GET /api/data/v9.2/opportunities`

**Query parameters:**
- `$select` — e.g. `name,estimatedvalue,estimatedclosedate,stepname`
- `$filter` — e.g. `statecode eq 0` (open opportunities)

### Create Opportunity
`POST /api/data/v9.2/opportunities`

**Request body (JSON):**
```json
{
  "name": "Enterprise License Deal",
  "estimatedvalue": 100000,
  "estimatedclosedate": "2024-06-30",
  "parentcontactid@odata.bind": "/contacts(a1b2c3d4...)"
}
```

### List Tasks
`GET /api/data/v9.2/tasks`

**Query parameters:**
- `$select` — e.g. `subject,description,scheduledstart,scheduledend,statecode`

### Create Task
`POST /api/data/v9.2/tasks`

**Request body (JSON):**
```json
{
  "subject": "Follow up with client",
  "description": "Discuss contract terms",
  "scheduledstart": "2024-03-15T10:00:00Z",
  "scheduledend": "2024-03-15T11:00:00Z",
  "regardingobjectid_contact@odata.bind": "/contacts(a1b2c3d4...)"
}
```

### List Cases (Incidents)
`GET /api/data/v9.2/incidents`

**Query parameters:**
- `$select` — e.g. `title,ticketnumber,prioritycode,statecode`
- `$filter` — e.g. `statecode eq 0` (active cases)

## Common Patterns

### OData Query Options
- `$select=field1,field2` — Choose fields
- `$filter=statecode eq 0 and contains(name,'Acme')` — Filter records
- `$orderby=createdon desc` — Sort
- `$top=50` — Limit results
- `$expand=parentcustomerid_account($select=name)` — Include related entities
- `$count=true` — Include `@odata.count` in response

### OData Filter Operators
`eq`, `ne`, `gt`, `ge`, `lt`, `le`, `and`, `or`, `not`, `contains()`, `startswith()`, `endswith()`

### Pagination
When more records exist, response includes `@odata.nextLink` with the full URL for the next page. Follow it directly. Max `$top` is 5000.

### Lookup Fields
Related entity references use `_fieldname_value` for reading and `fieldname@odata.bind` for writing:
- Read: `"_parentcustomerid_value": "guid-here"`
- Write: `"parentcustomerid_account@odata.bind": "/accounts(guid-here)"`

### Error Format
```json
{
  "error": {
    "code": "0x80040217",
    "message": "Entity 'contact' with Id = 00000000-0000-0000-0000-000000000000 Does Not Exist"
  }
}
```

### Rate Limits
6000 requests per 5 minutes per user. Service protection limits return 429 with `Retry-After`. Monitor `x-ms-ratelimit-burst-remaining-xrm-requests` header.

## Important Notes
- **Instance URL** — The base URL is organization-specific (e.g. `myorg.api.crm.dynamics.com`). Regions use different suffixes (`crm2`, `crm4`, etc.).
- **OAuth scope** — In Microsoft documentation, delegated access should use an environment-specific scope such as `https://{org}.api.crm.dynamics.com/user_impersonation`. Confidential-client flows may instead use `https://{org}.api.crm.dynamics.com/.default`.
- **Appstrate limitation** — Because Appstrate provider manifests use static default scopes, this provider may require custom handling or manual verification for organizations whose OAuth flow requires an org-specific scope value.
- **Token refresh** — Access tokens expire after 1 hour. Automatic refresh via the runtime.
- **GUIDs** — All entity IDs are GUIDs in parentheses: `contacts(a1b2c3d4-...)`.
- **OData protocol** — All queries use OData v4 conventions. Include `Accept: application/json` and `OData-MaxVersion: 4.0` headers.
- **Lookup binding** — Use `@odata.bind` with the entity set path when setting related entities.
- **State codes** — Most entities use `statecode`: `0` = Active/Open, `1` = Inactive/Resolved, `2` = Cancelled.
- **Multi-tenant** — Uses `/common/` OAuth endpoint to support all Azure AD tenants.
