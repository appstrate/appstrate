# Authentication & Provider Connections

## Authentication

Appstrate supports two authentication methods:

### API Key (recommended for agents)

Use the `Authorization` header with a Bearer token. API keys have the prefix `ask_` followed by 48 hex characters. The organization is resolved automatically from the key — no `X-Org-Id` header needed.

```
Authorization: Bearer ask_abc123...
```

### Cookie Session

For browser-based flows. Sign in via `POST /api/auth/sign-in/email` with `{ "email": "...", "password": "..." }`. The session cookie is set automatically. All subsequent requests must include `credentials: "include"` and an `X-Org-Id` header.

### Getting and Validating an API Key

To make API calls, you need an API key. **This is the one thing you must ask the user for**, because creating a key requires prior authentication in the web UI.

**If you don't have a key yet**, tell the user:

> I need an Appstrate API key to proceed. You can create one in the web UI: **Organization Settings > API Keys > Create API Key**. The key starts with `ask_` and is shown only once.

**Once you have the key, validate it immediately** — don't just trust it:

```
GET {BASE_URL}/api/flows
Authorization: Bearer ask_...
```

- **200**: Key is valid. Proceed with your task.
- **401**: Key is invalid, expired, or revoked. Tell the user to check their API keys in Organization Settings.
- **403**: Key is valid but the user lacks admin permissions. Read-only operations will still work.

Store the validated key and base URL for all subsequent calls.

### Choosing the right method

- **API key**: Best for programmatic/agent access. Org is resolved from the key.
- **Cookie session**: Best for browser-based interactions. Requires `X-Org-Id` header.

---

## Provider Connections

Once a provider is configured, users connect their accounts to it. Connections are scoped per organization + user.

### Check Connection Status First

**Always check what's already connected before trying to connect anything:**

```
GET /auth/integrations
Authorization: Bearer ask_...
```

Returns all providers with their connection status (`connected`, `disconnected`, `expired`) and `authMode`.

If a provider is already `connected`, you don't need to do anything. If it's `disconnected` or `expired`, proceed with the appropriate connection method based on the provider's `authMode`.

### Connect via API Key

For providers with `authMode: "api_key"`. You need the external service's API key from the user — this is a secret you cannot discover.

```
POST /auth/connect/{providerId}/api-key
Authorization: Bearer ask_...
Content-Type: application/json

{ "apiKey": "sk-my-api-key-value" }
```

### Connect via Custom Credentials

For providers with `authMode: "custom"`. First, check the provider's `credentialSchema` (from `GET /api/providers`) to know what fields are required, then ask the user only for the credential values.

```
POST /auth/connect/{providerId}/credentials
Authorization: Bearer ask_...
Content-Type: application/json

{ "token": "abc123", "baseUrl": "https://api.example.com" }
```

The body must match the provider's `credentialSchema`.

### Connect via OAuth2

For providers with `authMode: "oauth2"`. This requires a browser interaction from the user.

```
POST /auth/connect/{providerId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "scopes": ["read", "write"] }
```

Returns `{ "authUrl": "https://provider.com/authorize?..." }`. Give this URL to the user and ask them to open it in their browser. After authorization, the callback at `GET /auth/callback` exchanges the code for tokens automatically.

After the user completes the OAuth flow, verify the connection by calling `GET /auth/integrations` again — the provider should now show `connected`.

### Disconnect

```
DELETE /auth/connections/{providerId}
Authorization: Bearer ask_...
```

### Admin Connections (Flow-level)

Flows can require providers in `admin` connection mode. An admin binds their personal connection to the flow:

```
POST /api/flows/{packageId}/providers/{providerId}/bind
Authorization: Bearer ask_...
```

This makes the admin's credentials available to all executions of that flow, regardless of who runs it.

**Check if a binding already exists**: The flow detail (`GET /api/flows/{packageId}`) shows `providers[].adminConnection` — if it's already set, the binding is done.
