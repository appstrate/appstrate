# Google Contacts API

Base URL: `https://people.googleapis.com/v1`

Google People API for managing contacts. Read, create, update, and delete contacts and contact groups. The `personFields` mask is required on most requests to specify which fields to return.

## Endpoints

### Get Current User
`GET /people/me`

Returns the authenticated user's profile.

**Query parameters:**
- `personFields` — Comma-separated fields to return (required). Common: `names,emailAddresses,phoneNumbers,photos`

**Response:**
```json
{
  "resourceName": "people/me",
  "etag": "%EgUBAj...",
  "names": [
    {
      "displayName": "John Doe",
      "familyName": "Doe",
      "givenName": "John",
      "metadata": { "primary": true, "source": { "type": "PROFILE" } }
    }
  ],
  "emailAddresses": [
    {
      "value": "john@gmail.com",
      "type": "home",
      "metadata": { "primary": true }
    }
  ],
  "photos": [
    {
      "url": "https://lh3.googleusercontent.com/...",
      "metadata": { "primary": true }
    }
  ]
}
```

### List Contacts
`GET /people/me/connections`

Returns the authenticated user's contacts. Deprecated — prefer `searchContacts` for filtered results.

**Query parameters:**
- `personFields` — Fields to return (required)
- `pageSize` — Max contacts per page (default 100, max 1000)
- `pageToken` — Token for next page
- `sortOrder` — `LAST_MODIFIED_ASCENDING`, `LAST_MODIFIED_DESCENDING`, `FIRST_NAME_ASCENDING`, `LAST_NAME_ASCENDING`

**Response:**
```json
{
  "connections": [
    {
      "resourceName": "people/c1234567890",
      "etag": "%EgUBAj...",
      "names": [
        { "displayName": "Alice Martin", "givenName": "Alice", "familyName": "Martin" }
      ],
      "emailAddresses": [
        { "value": "alice@example.com", "type": "work" }
      ],
      "phoneNumbers": [
        { "value": "+33612345678", "type": "mobile" }
      ],
      "organizations": [
        { "name": "Acme Corp", "title": "Engineer" }
      ]
    }
  ],
  "nextPageToken": "...",
  "totalPeople": 156,
  "totalItems": 156
}
```

### Search Contacts
`GET /people:searchContacts`

Search contacts by name, email, or phone number. Requires `contacts.readonly` scope.

**Query parameters:**
- `query` — Search query string
- `pageSize` — Max results (default 10, max 30)
- `readMask` — Fields to return (same as `personFields`)

**Response:**
```json
{
  "results": [
    {
      "person": {
        "resourceName": "people/c1234567890",
        "names": [{ "displayName": "Alice Martin" }],
        "emailAddresses": [{ "value": "alice@example.com" }]
      }
    }
  ]
}
```

### Get Contact
`GET /people/{resourceName}`

Returns a single contact. The `resourceName` format is `people/c1234567890`.

**Query parameters:**
- `personFields` — Fields to return (required)

### Create Contact
`POST /people:createContact`

Creates a new contact. Requires `contacts` scope.

**Request body (JSON):**
```json
{
  "names": [
    { "givenName": "Bob", "familyName": "Wilson" }
  ],
  "emailAddresses": [
    { "value": "bob@example.com", "type": "work" }
  ],
  "phoneNumbers": [
    { "value": "+33698765432", "type": "mobile" }
  ],
  "organizations": [
    { "name": "Acme Corp", "title": "Manager" }
  ],
  "addresses": [
    {
      "type": "work",
      "streetAddress": "123 Main St",
      "city": "Paris",
      "country": "France",
      "postalCode": "75001"
    }
  ]
}
```

### Update Contact
`PATCH /people/{resourceName}:updateContact`

Updates a contact. Requires `contacts` scope. Must include the `etag` from the GET response to prevent conflicts.

**Query parameters:**
- `updatePersonFields` — Comma-separated fields to update (required)

**Request body (JSON):**
```json
{
  "etag": "%EgUBAj...",
  "emailAddresses": [
    { "value": "bob.new@example.com", "type": "work" }
  ]
}
```

### Delete Contact
`DELETE /people/{resourceName}:deleteContact`

Deletes a contact permanently. Requires `contacts` scope.

### List Contact Groups
`GET /contactGroups`

Returns all contact groups (labels).

**Query parameters:**
- `pageSize` — Max groups per page (default 30, max 1000)
- `pageToken` — Token for next page
- `groupFields` — Fields to return (e.g. `name,memberCount`)

**Response:**
```json
{
  "contactGroups": [
    {
      "resourceName": "contactGroups/myContacts",
      "name": "My Contacts",
      "groupType": "SYSTEM_CONTACT_GROUP",
      "memberCount": 156
    },
    {
      "resourceName": "contactGroups/abc123",
      "name": "Clients",
      "groupType": "USER_CONTACT_GROUP",
      "memberCount": 42
    }
  ]
}
```

### Batch Get Contacts
`GET /people:batchGet`

Retrieves multiple contacts in a single request.

**Query parameters:**
- `resourceNames` — Repeated parameter with contact resource names (max 200)
- `personFields` — Fields to return (required)

### List Other Contacts
`GET /otherContacts`

Returns contacts auto-created from Gmail interactions. Requires `contacts.other.readonly` scope.

**Query parameters:**
- `readMask` — Fields to return (e.g. `names,emailAddresses`)
- `pageSize` — Max results (default 100, max 1000)
- `pageToken` — Token for next page

## Common Patterns

### Pagination
Token-based pagination:
- Response includes `nextPageToken`
- Pass as `pageToken` query parameter
- When no `nextPageToken` in response, no more pages

### Person Fields Mask
Most endpoints require a `personFields` or `readMask` parameter. Common values:
- `names` — Display name, given/family name
- `emailAddresses` — Email addresses with type
- `phoneNumbers` — Phone numbers with type
- `organizations` — Company, job title
- `addresses` — Physical addresses
- `birthdays` — Birthday dates
- `photos` — Profile photos
- `biographies` — Notes/bio
- `urls` — Website URLs
- `memberships` — Contact group memberships

Combine with commas: `names,emailAddresses,phoneNumbers,organizations`

### Error Format
```json
{
  "error": {
    "code": 400,
    "message": "Request must set personFields.",
    "status": "INVALID_ARGUMENT"
  }
}
```

## Important Notes
- Resource names follow the format `people/c{numericId}` for contacts.
- The `personFields` or `readMask` parameter is mandatory on all read endpoints — omitting it returns an error.
- Contact updates require the `etag` from the latest GET to prevent concurrent edit conflicts.
- "Other contacts" are auto-suggested from Gmail interactions — they are read-only.
- Rate limit: 90 read requests / 60 seconds per user, 600 write requests / 60 seconds.
- `searchContacts` results may be stale by a few minutes (index delay).
- To find which group a contact belongs to, include `memberships` in `personFields`.
