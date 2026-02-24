---
name: appstrate-api-guide
description: Comprehensive guide for autonomously operating the Appstrate platform via its REST API. Covers authentication, provider configuration, flow CRUD, skill and extension management, execution lifecycle, scheduling, and monitoring.
---

# Appstrate API Guide

Use this skill whenever you need to interact with the Appstrate platform programmatically. This covers the full API surface: authentication, provider setup, flow management, execution, scheduling, and monitoring.

## Live API Documentation

The complete, up-to-date API documentation is available directly from any Appstrate instance:

- **OpenAPI 3.1 spec (JSON)**: `GET /api/openapi.json` — machine-readable spec you can fetch and parse to discover all endpoints, schemas, and parameters.
- **Swagger UI (interactive)**: `GET /api/docs` — human-readable interactive documentation with "Try it out" functionality.

Both endpoints are **public** (no authentication required). If you need to check the exact schema of a request or response, or discover endpoints not covered in this skill, fetch the OpenAPI spec:

```
curl https://appstrate.com/api/openapi.json
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

### How to get an API key

To make API calls (via curl, scripts, or agents), you need an API key. **You cannot create one via the API without already being authenticated.** Guide the user through these steps:

1. Log in to the Appstrate web interface
2. Go to **Organization Settings** (click the org name or settings icon in the sidebar)
3. Navigate to the **API Keys** tab
4. Click **Create API Key**
5. Enter a name (e.g., "Agent access") and optionally set an expiration date (or choose "Never" for a permanent key)
6. Copy the generated key immediately — **it is shown only once** and cannot be retrieved later
7. The key looks like: `ask_` followed by 48 hex characters

Once the user provides you with the API key, you can use it in all subsequent API calls via the `Authorization: Bearer ask_...` header.

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

### List Providers

```
GET /api/providers
Authorization: Bearer ask_...
```

Response: Array of provider configurations with their auth mode, scopes, credential schema, and authorized URIs.

### Create a Provider

```
POST /api/providers
Authorization: Bearer ask_...
Content-Type: application/json

{
  "id": "my-custom-api",
  "displayName": "My Custom API",
  "authMode": "api_key",
  "credentialFieldName": "apiKey",
  "credentialHeaderName": "X-API-Key",
  "credentialHeaderPrefix": "",
  "authorizedUris": ["https://api.example.com/*"],
  "allowAllUris": false
}
```

For OAuth2 providers, also include:

- `clientId` and `clientSecret` (encrypted at rest)
- `authorizationUrl` and `tokenUrl`
- `refreshUrl` (optional)
- `defaultScopes` (array of strings)
- `scopeSeparator` (default: space)
- `pkceEnabled` (boolean)
- `authorizationParams` and `tokenParams` (optional JSON objects)

For custom auth providers, include:

- `credentialSchema`: JSON Schema defining the credential fields (e.g., `{ "type": "object", "properties": { "token": { "type": "string" }, "baseUrl": { "type": "string" } }, "required": ["token"] }`)

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

### List Integrations (providers + connection status)

```
GET /auth/integrations
Authorization: Bearer ask_...
```

Returns all providers with their connection status (`connected`, `disconnected`, `expired`) and `authMode`.

### Connect via API Key

```
POST /auth/connect/{providerId}/api-key
Authorization: Bearer ask_...
Content-Type: application/json

{ "apiKey": "sk-my-api-key-value" }
```

### Connect via Custom Credentials

```
POST /auth/connect/{providerId}/credentials
Authorization: Bearer ask_...
Content-Type: application/json

{ "token": "abc123", "baseUrl": "https://api.example.com" }
```

The body must match the provider's `credentialSchema`.

### Connect via OAuth2

```
POST /auth/connect/{providerId}
Authorization: Bearer ask_...
Content-Type: application/json

{ "scopes": ["read", "write"] }
```

Returns `{ "authUrl": "https://provider.com/authorize?..." }`. The user must visit this URL to complete the OAuth flow. After authorization, the callback at `GET /auth/callback` exchanges the code for tokens.

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

### Create a Flow

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

```
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

The `updatedAt` field is required for optimistic locking — it must match the flow's current `updatedAt` value. Get it from `GET /api/flows/{flowId}`.

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

```
PUT /api/flows/{flowId}/config
Authorization: Bearer ask_...
Content-Type: application/json

{ "apiEndpoint": "https://api.example.com", "maxResults": 10 }
```

The body is validated against the flow's `config.schema` from the manifest.

### Update Linked Skills

```
PUT /api/flows/{flowId}/skills
Authorization: Bearer ask_...
Content-Type: application/json

{ "skillIds": ["web-research", "appstrate-api-guide"] }
```

### Update Linked Extensions

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
- **`requires.services[].provider`**: Must match a configured provider ID in the organization.
- **`requires.services[].connectionMode`**: `"user"` (default) = each user connects individually. `"admin"` = admin binds once for all users.
- **`requires.skills`** and **`requires.extensions`**: Arrays of skill/extension IDs from the library.
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

Returns 409 if still referenced by flows.

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

---

## Common Workflows

### Workflow 1: Set up a new external service integration

1. Create a provider: `POST /api/providers` with auth mode, credentials config, authorized URIs
2. Connect to it: `POST /auth/connect/{providerId}/api-key` (or `/credentials` or OAuth2)
3. Verify: `GET /auth/integrations` — check status is `connected`

### Workflow 2: Create and run a flow from scratch

1. (Optional) Create skills: `POST /api/library/skills`
2. (Optional) Create extensions: `POST /api/library/extensions`
3. Create the flow: `POST /api/flows` with manifest + prompt + skill/extension IDs
4. Configure it: `PUT /api/flows/{flowId}/config` (if config schema exists)
5. Connect required services: `POST /auth/connect/{providerId}/...` for each service
6. Bind admin services: `POST /api/flows/{flowId}/services/{serviceId}/bind` (for admin-mode services)
7. Run: `POST /api/flows/{flowId}/run` with input
8. Poll status: `GET /api/executions/{executionId}` until status is terminal
9. Get logs: `GET /api/executions/{executionId}/logs`

### Workflow 3: Monitor an execution to completion

```
1. POST /api/flows/{flowId}/run → { executionId }
2. Loop:
   GET /api/executions/{executionId}
   - If status is "pending" or "running": wait 2-5 seconds, retry
   - If status is "success": read result field
   - If status is "failed": read error field
   - If status is "timeout" or "cancelled": handle accordingly
3. GET /api/executions/{executionId}/logs → full execution log
```

### Workflow 4: Schedule a recurring flow

1. Ensure the flow exists and is configured
2. Create schedule: `POST /api/flows/{flowId}/schedules` with cron expression
3. Monitor: `GET /api/schedules` to see next run times
4. Check results: `GET /api/flows/{flowId}/executions` after scheduled runs

### Workflow 5: Update an existing flow

1. Get current state: `GET /api/flows/{flowId}` — note the `updatedAt` value
2. Update: `PUT /api/flows/{flowId}` with new manifest, prompt, and the `updatedAt` value
3. Update linked skills: `PUT /api/flows/{flowId}/skills` with updated skill IDs
4. Update linked extensions: `PUT /api/flows/{flowId}/extensions` with updated extension IDs

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

When rate-limited, the API returns HTTP 429 with `RATE_LIMITED` error code.

---

## Additional Files in This Skill

This skill includes additional reference files alongside this SKILL.md:

- **`manifest-template.json`** — A complete, ready-to-use flow manifest template with all field types (string, number, boolean, array, file, enum). Copy and adapt it instead of writing a manifest from scratch.
- **`TROUBLESHOOTING.md`** — Step-by-step diagnostic and resolution guide for all common errors (auth, validation, execution failures, rate limits). Consult it when an API call fails or an execution doesn't behave as expected.

These files are available in the same directory as this SKILL.md (`.pi/skills/appstrate-api-guide/`).

---

## Tips for Agents

1. **Always check flow detail before running**: `GET /api/flows/{flowId}` tells you what services, config, and input are needed.
2. **Poll with backoff**: When waiting for execution completion, use 2-5 second intervals with exponential backoff.
3. **Use pagination for logs**: Pass `?after={lastId}` to `GET /api/executions/{executionId}/logs` for incremental log retrieval.
4. **Validate input locally**: Match your input against the flow's `input.schema` before calling run to avoid 400 errors.
5. **Handle optimistic locking on updates**: Always pass the current `updatedAt` when updating a flow to avoid conflicts.
6. **Check provider authorized URIs**: If the agent needs to call a URL, ensure the provider's `authorizedUris` includes it.
7. **Use state for continuity**: If your flow needs to remember data between runs, include a `state` field in the output. It will be injected as `## Previous State` in subsequent executions.
