---
name: appstrate-api-guide
description: Comprehensive guide for autonomously operating the Appstrate platform via its REST API. Covers authentication, provider configuration, flow CRUD, skill and extension management, execution lifecycle, scheduling, and monitoring.
---

# Appstrate API Guide

Use this skill whenever you need to interact with the Appstrate platform programmatically. This covers the full API surface: authentication, provider setup, flow management, execution, scheduling, and monitoring.

## Agent Autonomy Principles

**You are an autonomous agent. Gather information from the API before asking the user anything.**

### Discover First, Ask Last

Before performing any action or asking any question, call the relevant GET endpoints to understand the current state:

1. **Need to know what flows exist?** → Call `GET /api/flows` — don't ask the user
2. **Need to know what providers are configured?** → Call `GET /api/providers` — don't ask the user
3. **Need to know what services are connected?** → Call `GET /auth/integrations` — don't ask the user
4. **Need to know what skills/extensions are available?** → Call `GET /api/library/skills` and `GET /api/library/extensions` — don't ask the user
5. **Need to know the flow's requirements?** → Call `GET /api/flows/{flowId}` — don't ask the user
6. **Need to know if config is set?** → The flow detail response includes current `config` values — don't ask the user

### Only Ask the User When You Must

The user should only be asked for things that **cannot be discovered via the API**:

- **API key**: The agent cannot create one programmatically without prior authentication. The user must create it in the web UI and provide it.
- **OAuth browser flow**: The user must open a URL in their browser to authorize an OAuth2 connection. You can generate the URL via the API, but the user must visit it.
- **Secrets and credentials**: API keys for external services (e.g., Brevo API key) are sensitive — the user must provide them.
- **Business decisions**: Which flow to create, what the prompt should say, what service to use — these require human judgment.

### Standard Discovery Sequence

When starting any task involving Appstrate, run this sequence to build your understanding:

```
1. GET /api/flows                    → What flows exist? What's their status?
2. GET /api/providers                → What providers are configured?
3. GET /auth/integrations            → What services are connected/disconnected?
4. GET /api/library/skills           → What skills are available?
5. GET /api/library/extensions       → What extensions are available?
```

You do NOT need to run all 5 every time — pick the ones relevant to your task. But **always gather context before acting**.

---

## Live API Documentation

The complete, up-to-date API documentation is available directly from any Appstrate instance:

- **OpenAPI 3.1 spec (JSON)**: `GET /api/openapi.json` — machine-readable spec you can fetch and parse to discover all endpoints, schemas, and parameters.
- **Swagger UI (interactive)**: `GET /api/docs` — human-readable interactive documentation with "Try it out" functionality.

Both endpoints are **public** (no authentication required). If you need to check the exact schema of a request or response, or discover endpoints not covered in this skill, fetch the OpenAPI spec:

```
curl {BASE_URL}/api/openapi.json
```

This is the authoritative source of truth for the API surface. Use it whenever you are unsure about a parameter, field type, or endpoint path.

---

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

## Provider Configuration

Providers define how Appstrate connects to external services (Gmail, ClickUp, Brevo, custom APIs). Each provider belongs to an organization and specifies an authentication mode.

### Auth Modes

| Mode      | Description                                                       | Example                         |
| --------- | ----------------------------------------------------------------- | ------------------------------- |
| `oauth2`  | Full OAuth2 flow with authorization URL, token URL, optional PKCE | Gmail, Google Calendar, ClickUp |
| `api_key` | Simple API key stored encrypted                                   | Brevo, SendGrid                 |
| `basic`   | Username + password                                               | SMTP servers                    |
| `custom`  | Dynamic credential schema defined per provider                    | Any custom service              |

### Discovering Existing Providers

**Always list existing providers before creating a new one:**

```
GET /api/providers
Authorization: Bearer ask_...
```

Response: Array of provider configurations with their `id`, `displayName`, `authMode`, scopes, credential schema, and authorized URIs.

**Check if the provider you need already exists.** If a provider with the right `authMode` and configuration is already present, skip creation and proceed to connecting.

### Provider Research & Creation Workflow

When a flow needs an external service (e.g., Gmail, Slack, Notion, Stripe) and the provider doesn't exist yet, **you must research the service yourself before asking the user anything**.

#### Step 1: Check if the provider already exists

```
GET /api/providers
Authorization: Bearer ask_...
```

Search the response for a provider matching the external service. If found, skip to "Service Connections" section. If not found, continue to Step 2.

#### Step 2: Research the external service's API

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

#### Step 3: Determine the auth mode and guide the user

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

#### Step 4: Create the provider via API

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

#### Step 5: Connect and verify

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

#### Complete Example: Adding Notion integration

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
→ Now create the flow that uses this service
```

### Create a Provider (Reference)

Full `POST /api/providers` field reference:

**Common fields (all auth modes):**
- `id` (string, required): kebab-case identifier
- `displayName` (string, required): Human-readable name
- `authMode` (string, required): `"oauth2"`, `"api_key"`, `"basic"`, or `"custom"`
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

**Custom auth fields:**
- `credentialSchema`: JSON Schema defining the credential fields

### Update a Provider

```
PUT /api/providers/{providerId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "displayName": "Updated Name", "authorizedUris": ["https://new-api.example.com/*"] }
```

Note: Built-in providers (loaded from `data/providers.json` or `SYSTEM_PROVIDERS` env) cannot be modified via API.

### Delete a Provider

```
DELETE /api/providers/{providerId}
Authorization: Bearer ask_...
```

Returns 409 if the provider is still referenced by flows.

### Authorized URIs

Every provider can restrict which URLs the agent is allowed to call through the sidecar proxy:

- `authorizedUris`: Array of URL patterns with `*` wildcards (e.g., `["https://api.example.com/*"]`)
- `allowAllUris`: Set to `true` to allow any URL (use with caution)

The sidecar validates every outbound request against these patterns before forwarding.

---

## Service Connections

Once a provider is configured, users connect their accounts to it. Connections are scoped per organization + user.

### Check Connection Status First

**Always check what's already connected before trying to connect anything:**

```
GET /auth/integrations
Authorization: Bearer ask_...
```

Returns all providers with their connection status (`connected`, `disconnected`, `expired`) and `authMode`.

If a service is already `connected`, you don't need to do anything. If it's `disconnected` or `expired`, proceed with the appropriate connection method based on the provider's `authMode`.

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

Flows can require services in `admin` connection mode. An admin binds their personal connection to the flow:

```
POST /api/flows/{flowId}/services/{serviceId}/bind
Authorization: Bearer ask_...
```

This makes the admin's credentials available to all executions of that flow, regardless of who runs it.

**Check if a binding already exists**: The flow detail (`GET /api/flows/{flowId}`) shows `services[].adminConnection` — if it's already set, the binding is done.

---

## Flow Management

Flows are the core unit of work in Appstrate. Each flow is an AI agent task defined by a manifest (JSON) and a prompt (Markdown).

### Flow Sources

- **Built-in**: Loaded from `data/flows/` at startup. Cannot be modified or deleted via API.
- **User**: Created via API or ZIP import. Stored in DB + filesystem.

### List Flows

```
GET /api/flows
Authorization: Bearer ask_...
```

Returns all flows (built-in + user) with `id`, `displayName`, `description`, `source`, `tags`, and `runningExecutions` count.

### Get Flow Detail

```
GET /api/flows/{flowId}
Authorization: Bearer ask_...
```

Returns complete flow information including:

- `manifest`: Full manifest JSON
- `prompt`: Agent prompt markdown
- `services`: Array of required services with connection status
- `config`: Current configuration values
- `lastExecution`: Most recent execution summary
- `runningExecutions`: Count of active executions
- `skills`: Linked skill IDs
- `extensions`: Linked extension IDs

**This is your primary source of truth for a flow.** Before running, configuring, or modifying any flow, always fetch its detail first.

### Create a Flow

**First check if the flow ID already exists** via `GET /api/flows`:

```
POST /api/flows
Authorization: Bearer ask_...
Content-Type: application/json

{
  "manifest": { ... },
  "prompt": "# My Agent\n\nYour task is to...",
  "skillIds": ["web-research"],
  "extensionIds": ["web-fetch"]
}
```

Returns `{ "flowId": "my-flow-id" }`. Rate-limited to 10/min.

### Update a Flow

**Always fetch the current flow first** to get the `updatedAt` value (required for optimistic locking):

```
GET /api/flows/{flowId}   → note updatedAt value

PUT /api/flows/{flowId}
Authorization: Bearer ask_...
Content-Type: application/json

{
  "manifest": { ... },
  "prompt": "# Updated prompt...",
  "updatedAt": "2026-01-15T10:00:00.000Z",
  "skillIds": ["web-research"],
  "extensionIds": ["web-fetch"]
}
```

### Delete a Flow

```
DELETE /api/flows/{flowId}
Authorization: Bearer ask_...
```

Only user flows can be deleted. Returns 204 on success.

### Import a Flow from ZIP

```
POST /api/flows/import
Authorization: Bearer ask_...
Content-Type: multipart/form-data

file: <flow.zip>
```

The ZIP must contain `manifest.json` and `prompt.md` at the root. Optional `skills/` and `extensions/` directories.

### Save Flow Configuration

**First check what config is currently set** via `GET /api/flows/{flowId}` (look at `config` field and `manifest.config.schema` for what fields exist):

```
PUT /api/flows/{flowId}/config
Authorization: Bearer ask_...
Content-Type: application/json

{ "apiEndpoint": "https://api.example.com", "maxResults": 10 }
```

The body is validated against the flow's `config.schema` from the manifest.

### Update Linked Skills

**First check available skills** via `GET /api/library/skills`:

```
PUT /api/flows/{flowId}/skills
Authorization: Bearer ask_...
Content-Type: application/json

{ "skillIds": ["web-research", "appstrate-api-guide"] }
```

### Update Linked Extensions

**First check available extensions** via `GET /api/library/extensions`:

```
PUT /api/flows/{flowId}/extensions
Authorization: Bearer ask_...
Content-Type: application/json

{ "extensionIds": ["web-fetch", "web-search"] }
```

### Flow Versions

Every create/update creates a version snapshot:

```
GET /api/flows/{flowId}/versions
Authorization: Bearer ask_...
```

Returns version history (newest first) with `versionNumber`, `createdBy`, `createdAt`.

---

## Flow Manifest Format

The manifest defines a flow's metadata, dependencies, input/output schemas, and execution settings.

### Complete Manifest Structure

```json
{
  "schemaVersion": "1.0.0",
  "metadata": {
    "id": "my-flow-id",
    "displayName": "My Flow",
    "description": "What this flow does",
    "author": "your-name",
    "tags": ["category1", "category2"],
    "license": "MIT"
  },
  "requires": {
    "services": [
      {
        "id": "gmail",
        "provider": "google-gmail",
        "scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
        "connectionMode": "user"
      }
    ],
    "skills": ["web-research"],
    "extensions": ["web-fetch"]
  },
  "input": {
    "schema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Search query",
          "placeholder": "Enter your query..."
        },
        "limit": {
          "type": "number",
          "description": "Max results",
          "default": 10
        },
        "document": {
          "type": "file",
          "description": "Upload a document",
          "accept": ".pdf,.docx",
          "maxSize": 10485760,
          "multiple": false
        }
      },
      "required": ["query"]
    }
  },
  "output": {
    "schema": {
      "type": "object",
      "properties": {
        "summary": { "type": "string", "description": "Result summary" },
        "items": { "type": "array", "description": "Result items" }
      },
      "required": ["summary"]
    }
  },
  "config": {
    "schema": {
      "type": "object",
      "properties": {
        "apiEndpoint": {
          "type": "string",
          "description": "API endpoint URL",
          "default": "https://api.example.com"
        },
        "verbose": {
          "type": "boolean",
          "description": "Enable verbose output",
          "default": false
        }
      }
    }
  },
  "execution": {
    "timeout": 300,
    "outputRetries": 2
  }
}
```

### Key Rules

- **`metadata.id`**: Must be a kebab-case slug (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
- **`requires.services[].id`**: Also kebab-case. This is the service identifier used for connection binding.
- **`requires.services[].provider`**: Must match a configured provider ID in the organization. **Verify it exists** via `GET /api/providers` before referencing it in a manifest.
- **`requires.services[].connectionMode`**: `"user"` (default) = each user connects individually. `"admin"` = admin binds once for all users.
- **`requires.skills`** and **`requires.extensions`**: Arrays of skill/extension IDs from the library. **Verify they exist** via `GET /api/library/skills` and `GET /api/library/extensions`.
- **`input.schema.required`**: Array at the object level. Do NOT use `required: true` on individual properties.
- **Field types**: `string`, `number`, `boolean`, `array`, `object`, `file`.
- **`execution.timeout`**: In seconds. Default varies by adapter.
- **`execution.outputRetries`**: 0-5. Number of retry attempts if output validation fails. Default 2 when output schema exists.

### Service Connection Modes

- **`user` mode** (default): Each user who runs the flow must have their own connection to the service. The agent uses the running user's credentials.
- **`admin` mode**: An admin binds their connection to the flow once. All executions use the admin's credentials regardless of who triggers the run. Useful for shared resources (e.g., a team Gmail inbox).

---

## Library: Skills & Extensions

The library contains reusable components that flows can reference.

### Skills

Skills are Markdown instruction files that guide the agent's behavior. They are injected into the execution container at `.pi/skills/{skill-id}/SKILL.md`.

#### Skill Format

A SKILL.md file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: What this skill does and when to use it.
---

# Skill Title

## When to Use

- Scenario 1
- Scenario 2

## Instructions

1. Step one
2. Step two

## Examples

...
```

#### List Skills

```
GET /api/library/skills
Authorization: Bearer ask_...
```

Returns built-in + org skills with `id`, `name`, `description`, `source`, `usedByFlows` count.

#### Create a Skill

**First check if the skill ID already exists** via `GET /api/library/skills`:

```
POST /api/library/skills
Authorization: Bearer ask_...
Content-Type: application/json

{
  "id": "my-skill",
  "content": "---\nname: my-skill\ndescription: Does something useful\n---\n\n# My Skill\n\n...",
  "name": "My Skill",
  "description": "Does something useful"
}
```

The `name` and `description` are auto-extracted from YAML frontmatter if omitted.

#### Get Skill Detail

```
GET /api/library/skills/{skillId}
Authorization: Bearer ask_...
```

Returns full content, metadata, and list of flows referencing this skill.

#### Update a Skill

```
PUT /api/library/skills/{skillId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "content": "---\nname: updated-skill\n...", "name": "Updated", "description": "New desc" }
```

Built-in skills cannot be modified (403).

#### Delete a Skill

```
DELETE /api/library/skills/{skillId}
Authorization: Bearer ask_...
```

Returns 409 if still referenced by flows. **Check which flows reference it first** via `GET /api/library/skills/{skillId}` (includes `flows` field).

### Extensions

Extensions are TypeScript files that add tools to the Pi agent. They follow the ExtensionFactory pattern.

#### Extension Format

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    description: "What the tool does",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string", description: "Tool input" },
      },
      required: ["input"],
    },
    async execute(_toolCallId, params, _signal) {
      // params.input contains the value
      const result = `Processed: ${params.input}`;
      return { content: [{ type: "text" as const, text: result }] };
    },
  });
}
```

**Critical details:**

- Import from `@mariozechner/pi-coding-agent` (NOT `pi-agent`)
- `execute` signature: `(_toolCallId, params, signal)` — params is the **second** argument
- Return type: `{ content: [{ type: "text", text: "..." }] }`
- Parameters: Plain JSON Schema objects

#### Extension CRUD

Same pattern as skills:

```
GET    /api/library/extensions              # List all
POST   /api/library/extensions              # Create (id + content required)
GET    /api/library/extensions/{extensionId} # Get detail with source code
PUT    /api/library/extensions/{extensionId} # Update
DELETE /api/library/extensions/{extensionId} # Delete (409 if in use)
```

---

## Flow Execution

### Pre-flight Check (Mandatory)

**Before running any flow, always call `GET /api/flows/{flowId}` and verify:**

1. **Services**: Every entry in `services[]` must have `status: "connected"`. If any is `disconnected` or `expired`, resolve it before running.
2. **Admin bindings**: For services with `connectionMode: "admin"`, check `adminConnection` is set. If not, bind via `POST /api/flows/{flowId}/services/{serviceId}/bind`.
3. **Config**: Compare `config` (current values) against `manifest.config.schema` — ensure all `required` fields have values. If not, set them via `PUT /api/flows/{flowId}/config`.
4. **Running executions**: Check `runningExecutions` — if > 0, either wait or cancel the existing one.
5. **Input schema**: Read `manifest.input.schema` to know what input fields are required and their types.

Only ask the user for information that's not in the API response (e.g., what input values to use for this run).

### Run a Flow

```
POST /api/flows/{flowId}/run
Authorization: Bearer ask_...
Content-Type: application/json

{ "input": { "query": "Hello world", "limit": 5 } }
```

For flows with file inputs, use `multipart/form-data`:

```
POST /api/flows/{flowId}/run
Authorization: Bearer ask_...
Content-Type: multipart/form-data

input: {"language": "french"}
document: <file binary>
```

Returns `{ "executionId": "exec-abc123" }`. The execution runs asynchronously in a Docker container. Rate-limited to 20/min.

### Get Execution Status

```
GET /api/executions/{executionId}
Authorization: Bearer ask_...
```

Response:

```json
{
  "id": "exec-abc123",
  "flowId": "my-flow",
  "status": "running",
  "input": { "query": "Hello" },
  "result": null,
  "state": null,
  "error": null,
  "tokensUsed": 1500,
  "tokenUsage": { "inputTokens": 500, "outputTokens": 1000 },
  "costUsd": "0.015",
  "startedAt": "2026-01-15T10:00:00Z",
  "completedAt": null,
  "duration": null
}
```

Status values: `pending`, `running`, `success`, `failed`, `timeout`, `cancelled`.

### Get Execution Logs

```
GET /api/executions/{executionId}/logs
Authorization: Bearer ask_...
```

Optional pagination: `?after={lastLogId}` for incremental fetching.

Returns array of log entries:

```json
[
  {
    "id": 1,
    "type": "system",
    "event": "execution_started",
    "message": "Execution started",
    "data": { "executionId": "exec-abc123" },
    "createdAt": "2026-01-15T10:00:00Z"
  },
  {
    "id": 2,
    "type": "agent",
    "event": "progress",
    "message": "Processing query...",
    "data": null,
    "createdAt": "2026-01-15T10:00:01Z"
  }
]
```

Log types: `system`, `agent`, `error`, `result`.

### Stream Execution (SSE)

```
GET /api/executions/{executionId}/stream
Authorization: Cookie-based only (not API key)
```

Server-Sent Events stream. First replays all existing logs from DB, then streams live updates.

SSE event types:

- `execution_started`: `{ executionId, startedAt }`
- `dependency_check`: `{ services: { gmail: "ok" } }`
- `adapter_started`: `{ adapter: "pi" }`
- `progress`: `{ message: "..." }` (repeated during execution)
- `result`: `{ summary: "...", ... }` (the flow output)
- `execution_completed`: `{ executionId, status: "success"|"failed"|"timeout" }`

### Cancel Execution

```
POST /api/executions/{executionId}/cancel
Authorization: Bearer ask_...
```

### List Flow Executions

```
GET /api/flows/{flowId}/executions?limit=50
Authorization: Bearer ask_...
```

### Delete Flow Executions

```
DELETE /api/flows/{flowId}/executions
Authorization: Bearer ask_...
```

Deletes all completed executions for the flow. Returns `{ "deleted": 15 }`.

### Execution Lifecycle

1. `POST /api/flows/{flowId}/run` validates input, checks service dependencies, creates execution record (status: `pending`)
2. Execution runs in background: creates isolated Docker network, starts sidecar proxy + agent container
3. Agent container receives the enriched prompt (raw prompt.md + structured context sections)
4. Agent calls external services via the sidecar proxy at `$SIDECAR_URL/proxy` with `X-Service` and `X-Target` headers
5. Agent streams progress events on stdout as JSON lines
6. On completion, result is validated against `output.schema` (if defined). If invalid, retries up to `outputRetries` times
7. Final result and status are persisted. If `result.state` exists, it's saved for the next execution

### State Persistence

Flows can maintain state across executions. If the agent's result includes a `state` field, it's persisted and injected into the next run as `## Previous State` in the prompt context. The agent can also query historical executions via the sidecar's `/execution-history` endpoint.

---

## Scheduling

Flows can be scheduled to run automatically via cron expressions.

### Create a Schedule

**First check existing schedules** to avoid duplicates:

```
GET /api/flows/{flowId}/schedules
Authorization: Bearer ask_...
```

Then create:

```
POST /api/flows/{flowId}/schedules
Authorization: Bearer ask_...
Content-Type: application/json

{
  "name": "Daily report",
  "cronExpression": "0 9 * * *",
  "timezone": "Europe/Paris",
  "enabled": true,
  "input": { "query": "daily summary" }
}
```

### List Schedules

```
GET /api/schedules
Authorization: Bearer ask_...
```

Returns all schedules across all flows, or filter by flow:

```
GET /api/flows/{flowId}/schedules
Authorization: Bearer ask_...
```

### Update a Schedule

```
PUT /api/schedules/{scheduleId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "enabled": false }
```

Updatable fields: `cronExpression`, `timezone`, `enabled`, `input`, `name`.

### Delete a Schedule

```
DELETE /api/schedules/{scheduleId}
Authorization: Bearer ask_...
```

### Cron Expression Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

| Expression     | Meaning                 |
| -------------- | ----------------------- |
| `* * * * *`    | Every minute            |
| `0 * * * *`    | Every hour              |
| `0 9 * * *`    | Every day at 9:00       |
| `0 9 * * 1-5`  | Weekdays at 9:00        |
| `*/15 * * * *` | Every 15 minutes        |
| `0 0 1 * *`    | First day of each month |

---

## Realtime Monitoring (SSE)

For browser-based monitoring, Appstrate provides SSE endpoints powered by PostgreSQL LISTEN/NOTIFY:

```
GET /api/realtime/executions              # All execution status changes
GET /api/realtime/executions/{executionId} # Single execution status + logs
GET /api/realtime/flows/{flowId}/executions # Execution changes for a flow
```

These are cookie-auth only (no API key support). Use `EventSource` in the browser or similar SSE client.

---

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
POST /api/flows/{flowId}/share-token
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

---

## Error Handling

### Error Response Format

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description"
}
```

### Common Error Codes

| Code                       | HTTP | Meaning                                     |
| -------------------------- | ---- | ------------------------------------------- |
| `FLOW_NOT_FOUND`           | 404  | Flow ID does not exist                      |
| `VALIDATION_ERROR`         | 400  | Input/config validation failed              |
| `DEPENDENCY_NOT_SATISFIED` | 400  | Required service not connected              |
| `CONFIG_INCOMPLETE`        | 400  | Required config fields missing              |
| `EXECUTION_IN_PROGRESS`    | 409  | Concurrent execution limit reached          |
| `UNAUTHORIZED`             | 401  | Missing or invalid authentication           |
| `FORBIDDEN`                | 403  | Insufficient permissions (not admin)        |
| `NAME_COLLISION`           | 400  | Flow/skill/extension ID already exists      |
| `MISSING_MANIFEST`         | 400  | ZIP import missing manifest.json            |
| `INVALID_MANIFEST`         | 400  | Manifest validation failed                  |
| `ZIP_INVALID`              | 400  | Corrupted or unreadable ZIP                 |
| `FILE_TOO_LARGE`           | 400  | Uploaded file exceeds size limit            |
| `MISSING_PROMPT`           | 400  | Flow missing prompt.md                      |
| `OPERATION_NOT_ALLOWED`    | 403  | Cannot modify built-in resource             |
| `FLOW_IN_USE`              | 409  | Cannot delete, resource referenced by flows |
| `RATE_LIMITED`             | 429  | Too many requests                           |

### Autonomous Error Recovery

When you get an error, **don't ask the user what to do**. Diagnose and resolve it yourself when possible:

| Error | Agent Action |
|-------|-------------|
| `DEPENDENCY_NOT_SATISFIED` | Call `GET /api/flows/{flowId}` → find which service has `status: "disconnected"` → call `GET /auth/integrations` to check the provider's `authMode` → if `api_key` or `custom`, ask user for credentials and connect. If `oauth2`, generate the auth URL and give it to the user. |
| `CONFIG_INCOMPLETE` | Call `GET /api/flows/{flowId}` → read `manifest.config.schema` to find required fields → check which are missing in `config` → if fields have `default` values, set them via `PUT /api/flows/{flowId}/config`. If no defaults, ask the user for values. |
| `NAME_COLLISION` | The resource already exists. Call `GET /api/flows` (or skills/extensions) to find it, then decide: update instead of create, or choose a different ID. |
| `EXECUTION_IN_PROGRESS` | Call `GET /api/flows/{flowId}/executions?limit=5` → find the running execution → either poll it until completion, or cancel via `POST /api/executions/{execId}/cancel`. |
| `FLOW_IN_USE` | Call `GET /api/library/skills/{id}` or `GET /api/library/extensions/{id}` → read the `flows` field → unlink from those flows first. |
| `UNAUTHORIZED` | Validate the API key with `GET /api/flows`. If it fails, tell the user their key is invalid/expired and ask for a new one. |

---

## Common Workflows

### Workflow 1: Set up a new external service integration

```
1. GET /api/providers                         → Check if the provider already exists
2. IF not found:
   POST /api/providers                        → Create it (ask user only for auth details: clientId/secret for OAuth2, or credential schema for custom)
3. GET /auth/integrations                     → Check if already connected
4. IF not connected:
   - authMode "api_key" → Ask user for the external API key → POST /auth/connect/{providerId}/api-key
   - authMode "custom"  → Read credentialSchema from provider → Ask user for values → POST /auth/connect/{providerId}/credentials
   - authMode "oauth2"  → POST /auth/connect/{providerId} → Give authUrl to user → Wait → Verify via GET /auth/integrations
5. GET /auth/integrations                     → Confirm status is "connected"
```

### Workflow 2: Create and run a flow from scratch

```
1. GET /api/flows                             → Check if the flow ID already exists
2. GET /api/providers                         → Check which providers are available for services
3. GET /api/library/skills                    → Check available skills
4. GET /api/library/extensions                → Check available extensions
5. POST /api/flows                            → Create the flow (manifest + prompt + skillIds + extensionIds)
6. GET /api/flows/{flowId}                    → Verify creation, check service status
7. IF services disconnected:
   → Follow Workflow 1 for each missing service
8. IF config has required fields:
   PUT /api/flows/{flowId}/config             → Set config values
9. POST /api/flows/{flowId}/run               → Run with input
10. Poll: GET /api/executions/{executionId}   → Until status is terminal
11. GET /api/executions/{executionId}/logs     → Get full execution log
```

### Workflow 3: Monitor an execution to completion

```
1. POST /api/flows/{flowId}/run → { executionId }
2. Loop:
   GET /api/executions/{executionId}
   - If status is "pending" or "running": wait 2-5 seconds, retry
   - If status is "success": read result field
   - If status is "failed": read error field + GET /api/executions/{executionId}/logs for details
   - If status is "timeout" or "cancelled": handle accordingly
3. GET /api/executions/{executionId}/logs → full execution log
```

### Workflow 4: Schedule a recurring flow

```
1. GET /api/flows/{flowId}                    → Verify flow exists and is fully configured
2. GET /api/flows/{flowId}/schedules          → Check if a schedule already exists
3. IF no schedule exists:
   POST /api/flows/{flowId}/schedules         → Create with cron expression
4. GET /api/schedules                         → Verify creation and next run time
```

### Workflow 5: Update an existing flow

```
1. GET /api/flows/{flowId}                    → Get current manifest, prompt, updatedAt, skills, extensions
2. PUT /api/flows/{flowId}                    → Update with new manifest/prompt + the updatedAt value
3. GET /api/flows/{flowId}                    → Verify the update was applied
```

---

## Health Check

```
GET /health
```

No auth required. Returns:

```json
{
  "status": "healthy",
  "uptime_ms": 123456,
  "checks": {
    "database": "ok",
    "flows": "ok"
  }
}
```

Status is `degraded` if any check fails.

---

## Rate Limits

| Endpoint                  | Limit                    |
| ------------------------- | ------------------------ |
| `POST /api/flows/:id/run` | 20 requests/min per user |
| `POST /api/flows/import`  | 10 requests/min per user |
| `POST /api/flows`         | 10 requests/min per user |

When rate-limited, the API returns HTTP 429 with `RATE_LIMITED` error code. Wait 60 seconds before retrying.

---

## Additional Files in This Skill

This skill includes additional reference files alongside this SKILL.md:

- **`manifest-template.json`** — A complete, ready-to-use flow manifest template with all field types (string, number, boolean, array, file, enum). Copy and adapt it instead of writing a manifest from scratch.
- **`TROUBLESHOOTING.md`** — Step-by-step diagnostic and resolution guide for all common errors (auth, validation, execution failures, rate limits). Consult it when an API call fails or an execution doesn't behave as expected.

These files are available in the same directory as this SKILL.md (`.pi/skills/appstrate-api-guide/`).

---

## Tips for Agents

1. **Always discover before acting**: Call GET endpoints to understand the current state before creating, updating, or asking the user anything.
2. **Validate your API key immediately**: The first thing you do with a new key is `GET /api/flows` to verify it works.
3. **Check flow detail before running**: `GET /api/flows/{flowId}` tells you everything — services, config, input schema, running executions.
4. **Resolve blockers autonomously**: If a service is disconnected, figure out the `authMode` and initiate the connection. Only ask the user for secrets.
5. **Poll with backoff**: When waiting for execution completion, use 2-5 second intervals.
6. **Use pagination for logs**: Pass `?after={lastId}` to `GET /api/executions/{executionId}/logs` for incremental log retrieval.
7. **Handle optimistic locking**: Always fetch the current `updatedAt` before updating a flow.
8. **Check provider authorized URIs**: If the agent needs to call a URL, verify the provider's `authorizedUris` includes it via `GET /api/providers`.
9. **Use state for continuity**: If your flow needs to remember data between runs, include a `state` field in the output.
10. **Never guess, always verify**: If you're unsure whether something exists or is configured, call the API. It's free.
