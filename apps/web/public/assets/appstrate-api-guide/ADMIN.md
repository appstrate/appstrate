# Organization & Administration

## Organization Management

### List Organizations

```
GET /api/orgs
Authorization: Bearer ask_...
```

### Create Organization

```
POST /api/orgs
Authorization: Bearer ask_...
Content-Type: application/json

{ "name": "My Team", "slug": "my-team" }
```

Slug must match: `^[a-z0-9][a-z0-9-]*$`

### Invite a Member

```
POST /api/orgs/{orgId}/members
Authorization: Bearer ask_...
Content-Type: application/json

{ "email": "user@example.com", "role": "member" }
```

If the user exists, they're added directly. If not, an invitation token is created (7-day expiry). Response includes `{ "invited": true, "token": "..." }` — the invite link is `{APP_URL}/invite/{token}`.

### Change Member Role

```
PUT /api/orgs/{orgId}/members/{userId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "role": "admin" }
```

### Remove Member

```
DELETE /api/orgs/{orgId}/members/{userId}
Authorization: Bearer ask_...
```

---

## API Key Management

### Create an API Key

```
POST /api/api-keys
Authorization: Bearer ask_...
Content-Type: application/json

{ "name": "CI/CD Key", "expiresAt": "2027-01-01T00:00:00Z" }
```

Omit `expiresAt` for a non-expiring key. The raw key is returned **only once** in the response:

```json
{ "id": "key-id", "key": "ask_abc123...", "keyPrefix": "ask_abc1" }
```

### List API Keys

```
GET /api/api-keys
Authorization: Bearer ask_...
```

### Revoke an API Key

```
DELETE /api/api-keys/{keyId}
Authorization: Bearer ask_...
```

The key stops working immediately.

---

## Share Tokens (Public Execution Links)

Create a one-time public link for anyone to run a flow:

### Create Share Token

```
POST /api/flows/{packageId}/share-token
Authorization: Bearer ask_...
```

Returns `{ "token": "...", "url": "https://appstrate.com/share/...", "expiresAt": "..." }`.

### Run Shared Flow (no auth)

```
POST /share/{token}/run
Content-Type: application/json

{ "input": { "query": "test" } }
```

### Check Shared Execution Status (no auth)

```
GET /share/{token}/status
```
