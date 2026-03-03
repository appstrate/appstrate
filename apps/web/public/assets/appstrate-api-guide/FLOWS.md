# Flow Management

Flows are the core unit of work in Appstrate. Each flow is an AI agent task defined by a manifest (JSON) and a prompt (Markdown).

## Flow Sources

- **Built-in**: Loaded from `data/flows/` at startup. Cannot be modified or deleted via API.
- **User**: Created via API or ZIP import. Stored in DB + filesystem.

## List Flows

```
GET /api/flows
Authorization: Bearer ask_...
```

Returns all flows (built-in + user) with `id`, `displayName`, `description`, `source`, `tags`, and `runningExecutions` count.

## Get Flow Detail

```
GET /api/flows/{packageId}
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

## Create a Flow

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

Returns `{ "packageId": "my-flow-id" }`. Rate-limited to 10/min.

## Update a Flow

**Always fetch the current flow first** to get the `updatedAt` value (required for optimistic locking):

```
GET /api/flows/{packageId}   → note updatedAt value

PUT /api/flows/{packageId}
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

## Delete a Flow

```
DELETE /api/flows/{packageId}
Authorization: Bearer ask_...
```

Only user flows can be deleted. Returns 204 on success.

## Import a Flow from ZIP

```
POST /api/flows/import
Authorization: Bearer ask_...
Content-Type: multipart/form-data

file: <flow.zip>
```

The ZIP must contain `manifest.json` and `prompt.md` at the root. Optional `skills/` and `extensions/` directories.

## Save Flow Configuration

**First check what config is currently set** via `GET /api/flows/{packageId}` (look at `config` field and `manifest.config.schema` for what fields exist):

```
PUT /api/flows/{packageId}/config
Authorization: Bearer ask_...
Content-Type: application/json

{ "apiEndpoint": "https://api.example.com", "maxResults": 10 }
```

The body is validated against the flow's `config.schema` from the manifest.

## Update Linked Skills

**First check available skills** via `GET /api/library/skills`:

```
PUT /api/flows/{packageId}/skills
Authorization: Bearer ask_...
Content-Type: application/json

{ "skillIds": ["web-research", "appstrate-api-guide"] }
```

## Update Linked Extensions

**First check available extensions** via `GET /api/library/extensions`:

```
PUT /api/flows/{packageId}/extensions
Authorization: Bearer ask_...
Content-Type: application/json

{ "extensionIds": ["web-fetch", "web-search"] }
```

## Flow Versions

Every create/update creates a version snapshot:

```
GET /api/flows/{packageId}/versions
Authorization: Bearer ask_...
```

Returns version history (newest first) with `version` (semver string), `integrity`, `artifactSize`, `yanked`, `createdBy`, `createdAt`.

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

A ready-to-use manifest template is available in `manifest-template.json` in this skill directory.
