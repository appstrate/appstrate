# Provider Configuration

Providers define how Appstrate connects to external services (Gmail, ClickUp, Brevo, custom APIs). Each provider belongs to an organization and specifies an authentication mode.

## Auth Modes

| Mode      | Description                                                       | Example                         |
| --------- | ----------------------------------------------------------------- | ------------------------------- |
| `oauth2`  | Full OAuth2 flow with authorization URL, token URL, optional PKCE | Gmail, Google Calendar, ClickUp |
| `oauth1`  | OAuth 1.0a with HMAC-SHA1 (request token → authorize → access token) | Twitter/X, Tumblr               |
| `api_key` | Simple API key stored encrypted                                   | Brevo, SendGrid                 |
| `basic`   | Username + password                                               | SMTP servers                    |
| `custom`  | Dynamic credential schema defined per provider                    | Any custom service              |
| `proxy`   | Outbound HTTP proxy (auto-sets `allowAllUris: true`)              | SOCKS5/HTTP proxies             |

## Discovering Existing Providers

**Always list existing providers before creating a new one:**

```
GET /api/providers
Authorization: Bearer ask_...
```

Response: Array of provider configurations with their `id`, `displayName`, `authMode`, scopes, credential schema, and authorized URIs.

**Check if the provider you need already exists.** If a provider with the right `authMode` and configuration is already present, skip creation and proceed to connecting.

## Provider Research & Creation Workflow

When a flow needs an external service (e.g., Gmail, Slack, Notion, Stripe) and the provider doesn't exist yet, **you must research the service yourself before asking the user anything**.

### Step 1: Check if the provider already exists

```
GET /api/providers
Authorization: Bearer ask_...
```

Search the response for a provider matching the external service. If found, skip to the "Service Connections" section in `AUTH.md`. If not found, continue to Step 2.

### Step 2: Research the external service's API

**Use web search** to find the service's developer documentation. You need to determine:

1. **Authentication method**: Does the service use API keys, OAuth2, or both?
2. **API base URL**: What's the base URL for API calls? (e.g., `https://api.notion.com/*`, `https://api.slack.com/*`)
3. **If OAuth2**:
   - Authorization URL (e.g., `https://accounts.google.com/o/oauth2/v2/auth`)
   - Token URL (e.g., `https://oauth2.googleapis.com/token`)
   - Refresh URL (often the same as token URL)
   - Available scopes and their meaning
   - Whether PKCE is supported/required
4. **If API key**:
   - Where to generate a key (developer console, settings page, etc.)
   - How the key is sent (header name, prefix like `Bearer` or `Key`)

**Search queries to use:**
- `"{service name}" API authentication documentation`
- `"{service name}" OAuth2 setup developer`
- `"{service name}" API key authentication`
- `"{service name}" developer console create app`

### Step 3: Determine the auth mode and guide the user

Based on your research, tell the user exactly what they need to do on the external service's side.

**If the service uses OAuth2:**

Tell the user they need to create an OAuth app in the service's developer console. Be specific:

> To integrate {service}, you need to create an OAuth application in the {service} developer console. Here's how:
>
> 1. Go to {specific URL you found in docs}
> 2. Create a new application/project
> 3. Set the redirect URI (callback URL) to: `{OAUTH_CALLBACK_URL}` (typically `{BASE_URL}/auth/callback`)
> 4. Note down the **Client ID** and **Client Secret**
> 5. Give me the Client ID and Client Secret, and I'll configure the provider

**Key information to provide the user:**
- The exact URL of the developer console (found via web search)
- The redirect/callback URI they must configure: this is the Appstrate OAuth callback URL (`{BASE_URL}/auth/callback`)
- What permissions/scopes the app needs
- Any specific settings (e.g., "enable the Gmail API in Google Cloud Console")

**If the service uses API keys:**

> To integrate {service}, you need an API key. You can create one at: {specific URL}.
> Once you have it, give it to me and I'll configure the provider and connect it.

### Step 4: Create the provider via API

Once you have the necessary information from the user, create the provider:

**For API key providers:**

```
POST /api/providers
Authorization: Bearer ask_...
Content-Type: application/json

{
  "id": "{service-name}",
  "displayName": "{Service Display Name}",
  "authMode": "api_key",
  "credentialFieldName": "apiKey",
  "credentialHeaderName": "{header name from docs, e.g. 'Authorization'}",
  "credentialHeaderPrefix": "{prefix from docs, e.g. 'Bearer'}",
  "authorizedUris": ["{base API URL}/*"],
  "allowAllUris": false
}
```

**For OAuth2 providers:**

```
POST /api/providers
Authorization: Bearer ask_...
Content-Type: application/json

{
  "id": "{service-name}",
  "displayName": "{Service Display Name}",
  "authMode": "oauth2",
  "clientId": "{from user}",
  "clientSecret": "{from user}",
  "authorizationUrl": "{from docs}",
  "tokenUrl": "{from docs}",
  "refreshUrl": "{from docs, often same as tokenUrl}",
  "defaultScopes": ["{scopes from docs}"],
  "scopeSeparator": " ",
  "pkceEnabled": {true if supported},
  "authorizedUris": ["{base API URL}/*"],
  "allowAllUris": false
}
```

**For custom auth providers (multiple credential fields):**

```
POST /api/providers
Authorization: Bearer ask_...
Content-Type: application/json

{
  "id": "{service-name}",
  "displayName": "{Service Display Name}",
  "authMode": "custom",
  "credentialSchema": {
    "type": "object",
    "properties": {
      "token": { "type": "string", "description": "API token" },
      "workspace": { "type": "string", "description": "Workspace ID" }
    },
    "required": ["token"]
  },
  "authorizedUris": ["{base API URL}/*"],
  "allowAllUris": false
}
```

### Step 5: Connect and verify

After creating the provider, immediately connect the user's credentials and verify:

```
# For API key:
POST /auth/connect/{providerId}/api-key
{ "apiKey": "{user's key}" }

# For OAuth2:
POST /auth/connect/{providerId}
{ "scopes": ["{needed scopes}"] }
# → Give the authUrl to the user → Wait → Verify

# For custom:
POST /auth/connect/{providerId}/credentials
{ "token": "...", "workspace": "..." }

# Verify connection:
GET /auth/integrations
# → Confirm status is "connected"
```

### Complete Example: Adding Notion integration

```
Agent thinking:
1. User wants a flow that reads Notion pages
2. GET /api/providers → no "notion" provider found
3. Web search: "Notion API OAuth2 setup developer"
4. Found: Notion uses OAuth2 with internal integrations or public OAuth
5. Authorization URL: https://api.notion.com/v1/oauth/authorize
6. Token URL: https://api.notion.com/v1/oauth/token
7. Base API URL: https://api.notion.com/*

Agent to user:
"I need to set up a Notion integration. Please:
1. Go to https://www.notion.so/my-integrations
2. Click '+ New integration'
3. Choose 'Public integration' for OAuth2
4. Set the redirect URI to: {BASE_URL}/auth/callback
5. Give me the OAuth Client ID and OAuth Client Secret"

After user provides credentials:
POST /api/providers → create notion provider
POST /auth/connect/notion → get authUrl → user authorizes
GET /auth/integrations → verify connected
→ Now create the flow that uses this provider
```

## Create a Provider (Reference)

Full `POST /api/providers` field reference:

**Common fields (all auth modes):**
- `id` (string, required): kebab-case identifier
- `displayName` (string, required): Human-readable name
- `authMode` (string, required): `"oauth2"`, `"oauth1"`, `"api_key"`, `"basic"`, `"custom"`, or `"proxy"`
- `authorizedUris` (string[], recommended): URL patterns the sidecar proxy allows
- `allowAllUris` (boolean): Set to `true` to bypass URI restrictions (use with caution)
- `iconUrl` (string, optional): URL to provider icon
- `categories` (string[], optional): Provider categories
- `docsUrl` (string, optional): Link to provider documentation

**OAuth2-specific fields:**
- `clientId` and `clientSecret` (encrypted at rest)
- `authorizationUrl` and `tokenUrl` (required)
- `refreshUrl` (optional, often same as tokenUrl)
- `defaultScopes` (string[])
- `scopeSeparator` (default: `" "`)
- `pkceEnabled` (boolean)
- `authorizationParams` and `tokenParams` (optional JSON objects for extra query params)
- `availableScopes` (JSON array of `{ value, label, description }` for UI display)

**API key-specific fields:**
- `credentialFieldName`: Internal field name (e.g., `"apiKey"`)
- `credentialHeaderName`: HTTP header name (e.g., `"Authorization"`, `"X-API-Key"`)
- `credentialHeaderPrefix`: Prefix before the key value (e.g., `"Bearer"`, `""`)

**OAuth1-specific fields:**
- `clientId` and `clientSecret` (map to consumer key/secret, encrypted at rest)
- `requestTokenUrl` (required — initiate OAuth 1.0a flow)
- `accessTokenUrl` (required — exchange verifier for access token)
- `authorizationUrl` (required — user authorization redirect)

**Custom auth fields:**
- `credentialSchema`: JSON Schema defining the credential fields

**Proxy-specific fields:**
- Auto-sets `allowAllUris: true` and `credentialSchema` with a URL field
- No additional fields required beyond common fields

## Update a Provider

```
PUT /api/providers/{providerId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "displayName": "Updated Name", "authorizedUris": ["https://new-api.example.com/*"] }
```

Note: System providers (with source "system", loaded from ZIP packages at boot) cannot be modified via API.

## Delete a Provider

```
DELETE /api/providers/{providerId}
Authorization: Bearer ask_...
```

Returns 409 if the provider is still referenced by flows.

## Authorized URIs

Every provider can restrict which URLs the agent is allowed to call through the sidecar proxy:

- `authorizedUris`: Array of URL patterns with `*` wildcards (e.g., `["https://api.example.com/*"]`)
- `allowAllUris`: Set to `true` to allow any URL (use with caution)

The sidecar validates every outbound request against these patterns before forwarding.
