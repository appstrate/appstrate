# AFPS Manifest Schema Reference

> AFPS (Agent Flow Packaging Standard) v1.0 — https://afps.appstrate.dev/

Every package has a `manifest.json`. Schema validation: `https://afps.appstrate.dev/schema/v1/{type}.schema.json`

## Table of Contents

- [Common Fields](#common-fields)
- [Dependencies](#dependencies)
- [Agent Fields](#agent-fields)
- [Input/Output/Config Schemas](#inputoutputconfig-schemas)
- [State and Memories](#state-and-memories)
- [Skill Fields](#skill-fields)
- [Tool Fields](#tool-fields)
- [Provider Fields](#provider-fields)
- [Validation Rules](#validation-rules)

## Common Fields

| Field         | Type     | Required    | Description                              |
| ------------- | -------- | ----------- | ---------------------------------------- |
| `$schema`     | string   | No          | Schema URL for editor validation         |
| `name`        | string   | **Yes**     | Scoped name: `@scope/name`               |
| `version`     | string   | **Yes**     | Semver: `MAJOR.MINOR.PATCH[-prerelease]` |
| `type`        | enum     | **Yes**     | `agent`, `skill`, `tool`, `provider`     |
| `displayName` | string   | Agents: yes | Human-readable name                      |
| `description` | string   | No          | Short description                        |
| `keywords`    | string[] | No          | Tags for marketplace                     |
| `license`     | string   | No          | SPDX identifier                          |

Name regex: `^@[a-z0-9]([a-z0-9-]*[a-z0-9])?/[a-z0-9]([a-z0-9-]*[a-z0-9])?$`

In API paths, scope includes `@`: `@my-org/my-agent` → `/api/agents/@my-org/my-agent`

## Dependencies

```json
{
  "dependencies": {
    "providers": { "@appstrate/gmail": "^1.0.0" },
    "skills": { "@appstrate/email-writing": "^1.0.0" },
    "tools": { "@appstrate/web-scraper": "^1.0.0" }
  }
}
```

All three sub-fields optional. Values are semver ranges: `^1.0.0`, `~1.0.0`, `>=1.0.0 <2.0.0`, `*`.

## Agent Fields

| Field             | Type    | Required | Default | Description                              |
| ----------------- | ------- | -------- | ------- | ---------------------------------------- |
| `schemaVersion`   | string  | **Yes**  | —       | `"1.0"` (pattern: `^1\.(0\|[1-9]\d*)$`)  |
| `author`          | string  | **Yes**  | —       | Author name                              |
| `timeout`         | number  | No       | —       | Max execution time (seconds)             |
| `x-outputRetries` | integer | No       | 0       | Retry on output validation failure (0-5) |

### Providers Configuration

```json
{
  "providersConfiguration": {
    "@appstrate/gmail": {
      "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
      "connectionMode": "user"
    }
  }
}
```

- `scopes`: OAuth scopes needed
- `connectionMode`: `"user"` (per-user) or `"admin"` (shared org creds)

## Input/Output/Config Schemas

All use JSON Schema with these types:

| Type        | Notes                                                           |
| ----------- | --------------------------------------------------------------- |
| `"string"`  | Supports `enum`, `default`, `minLength`, `maxLength`, `pattern` |
| `"number"`  | Supports `minimum`, `maximum`. AJV coerces `"50"` -> `50`       |
| `"boolean"` | Supports `default`                                              |
| `"array"`   | Requires `items`                                                |
| `"object"`  | Nested `properties` + `required`                                |
| `"file"`    | Input only. `accept`, `maxSize` (bytes), `multiple`, `maxFiles` |

Display: `title` (label), `description` (help text), `default`, `propertyOrder` (field order).

**Critical**: `required` is a top-level array, NOT per-property boolean.

```json
{
  "input": {
    "schema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "title": "Search Query" },
        "limit": { "type": "number", "default": 10 }
      },
      "required": ["query"],
      "propertyOrder": ["query", "limit"]
    }
  }
}
```

## State and Memories

**State**: Free-form JSON, overwritten each run. Agent returns `result.state`, injected as `## Previous State` next run.

**Memories**: Single list shared across all users of the agent (appended, never overwritten). Injected as `## Memory` in the prompt. Use the `add_memory` tool to save learnings. No manifest config needed.

## Skill Fields

Minimal manifest. Content lives in `SKILL.md` (YAML frontmatter + Markdown).

```json
{
  "name": "@my-org/my-skill",
  "version": "1.0.0",
  "type": "skill",
  "displayName": "My Skill",
  "description": "What this skill provides"
}
```

Skills can bundle `scripts/`, `references/`, `assets/` directories. The entire .afps content is extracted into `.pi/skills/{id}/` in the container.

## Tool Fields

| Field              | Type   | Required | Description                                   |
| ------------------ | ------ | -------- | --------------------------------------------- |
| `entrypoint`       | string | **Yes**  | Path to TypeScript entry (e.g., `"index.ts"`) |
| `tool.name`        | string | **Yes**  | Tool identifier (snake_case)                  |
| `tool.description` | string | **Yes**  | Description for agent tool selection          |
| `tool.inputSchema` | object | **Yes**  | JSON Schema for parameters                    |

```json
{
  "name": "@my-org/my-tool",
  "version": "1.0.0",
  "type": "tool",
  "entrypoint": "index.ts",
  "tool": {
    "name": "my_tool",
    "description": "Does something useful",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search query" }
      },
      "required": ["query"]
    }
  }
}
```

**Execute signature**: `(toolCallId, params, signal)` — params is the **second** argument.
**Return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
**Import**: `import { tool } from "@mariozechner/pi-coding-agent"`

## Provider Fields

Key field: `definition` with `authMode`.

| Auth Mode | Use Case              | Key Fields                                                                   |
| --------- | --------------------- | ---------------------------------------------------------------------------- |
| `oauth2`  | Google, GitHub, Slack | `authorizationUrl`, `tokenUrl`, `refreshUrl`, `defaultScopes`, `pkceEnabled` |
| `oauth1`  | Twitter legacy        | `requestTokenUrl`, `authorizationUrl`, `accessTokenUrl`                      |
| `api_key` | OpenAI, SendGrid      | `credentialHeaderName`, `credentialHeaderPrefix`                             |
| `basic`   | JIRA basic auth       | (none extra)                                                                 |
| `custom`  | Multi-field creds     | `credentialSchema` (JSON Schema form)                                        |
| `proxy`   | HTTP proxy            | Auto-sets `allowAllUris: true`                                               |

Common definition fields: `authorizedUris` (URL patterns with `*` wildcards), `iconUrl`, `categories`, `docsUrl`, `setupGuide`, `availableScopes` (`[{ value, label }]`).

## Validation Rules

- Versions: forward-only, no downgrades
- `latest` dist-tag: auto-managed on non-prerelease publishes
- AJV: `coerceTypes: true`, no `additionalProperties: false`
- Custom fields: use `x-` prefix (e.g., `x-outputRetries`)
- Updates require `lockVersion` field (optimistic locking, 409 on conflict)
