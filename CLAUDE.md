# OpenFlows — Developer Guide

OpenFlows is an open-source platform for executing one-shot AI flows in ephemeral Docker containers. A user deploys via Docker Compose, connects OAuth services (Gmail, ClickUp), clicks "Run", and the AI agent processes their data autonomously inside a temporary container.

## Quick Start

```sh
# 1. Start infrastructure
docker compose up -d          # PostgreSQL 16 + Nango (OAuth)

# 2. Init database
bun run setup-db              # Creates tables in PostgreSQL

# 3. Build runtime image
bun run build-runtime         # docker build -t openflows-claude-code ./runtime-claude-code

# 4. Configure .env (copy .env.example, set CLAUDE_CODE_OAUTH_TOKEN)

# 5. Start platform
bun run dev                   # Hono server on http://localhost:3000
```

## Stack & Conventions

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | **Bun** | Use `bun` everywhere, not node. Bun auto-loads `.env` |
| API | **Hono** | NOT `Bun.serve()` — we need Hono for SSE (`streamSSE`), routing, middleware |
| DB | **postgres.js** (`postgres` package) | NOT `Bun.sql` — despite the auto-generated Bun CLAUDE.md suggestion |
| OAuth | **Nango** self-hosted (`@nangohq/node`) | Manages Gmail + ClickUp OAuth tokens |
| Docker | **Docker Engine API** via `fetch()` + unix socket | NOT dockerode (socket bugs with Bun) |
| Container runtime | **Claude Code CLI** in Node 20 Alpine | Uses `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |
| Frontend | **Vanilla JS + CSS** | No framework. `public/index.html` + `public/app.js` |
| Auth | Bearer token from `AUTH_TOKEN` env var | No auth on static files. All `/api/*` and `/auth/*` routes require bearer |

### Key Patterns

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Template interpolation**: `{{config.*}}`, `{{state.*}}`, `{{#if state.*}}...{{/if}}` in prompt.md files. Implemented in `interpolatePrompt()` in `src/routes/executions.ts`.
- **Credential injection**: OAuth tokens passed as env vars (`TOKEN_GMAIL`, `TOKEN_CLICKUP`) to the container. MVP simplicity — no proxy pattern.

## Architecture

```
User Browser                    Platform (Bun + Hono :3000)
     |                                |
     |-- GET /api/flows ------------->|-- flow-loader.ts (reads flows/ dir)
     |-- PUT /api/flows/:id/config -->|-- state.ts (PostgreSQL)
     |-- POST /auth/connect/:provider>|-- nango.ts --> createConnectSession() --> Nango (:3003)
     |                                |   returns connectLink for popup --> OAuth
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps & config
     |                                |-- 2. Get OAuth tokens from Nango
     |                                |-- 3. Interpolate prompt template
     |<-- SSE stream -----------------|-- 4. Create Docker container
     |<-- progress events ------------|-- 5. Stream container stdout
     |<-- result event ---------------|-- 6. Parse result, update state
     |<-- execution_completed --------|-- 7. Destroy container
     |                                |
     |            Ephemeral Container (Claude Code CLI)
     |            - Receives: FLOW_PROMPT, TOKEN_*, CONFIG_*, CLAUDE_CODE_OAUTH_TOKEN
     |            - Claude Code executes the prompt with access to bash/tools
     |            - Outputs JSON lines on stdout (parsed by ClaudeCodeAdapter)
```

## Project Structure

```
src/
├── index.ts                  # Hono app entry. CORS, auth middleware, route mounting, static serving
├── routes/
│   ├── flows.ts              # GET /api/flows, GET /api/flows/:id, PUT /api/flows/:id/config
│   ├── executions.ts         # POST /api/flows/:id/run (SSE), GET /api/executions/:id
│   └── auth.ts               # POST /auth/connect/:provider (connect session), GET /auth/connections
├── services/
│   ├── docker.ts             # dockerFetch(), createClaudeCodeContainer, startContainer, streamLogs, waitForExit, removeContainer, stopContainer
│   ├── adapters/
│   │   ├── types.ts          # ExecutionAdapter interface, ExecutionMessage type
│   │   ├── index.ts          # getAdapter() factory, getAdapterName(), re-exports
│   │   └── claude-code.ts    # ClaudeCodeAdapter (prompt enrichment, stream parsing, timeout)
│   ├── nango.ts              # getConnectionStatus, listConnections, getAccessToken, createConnectSession
│   ├── state.ts              # CRUD for flow_configs, flow_state, executions tables
│   └── flow-loader.ts        # Scans flows/ dir at startup, parses manifest.json + prompt.md
├── db/
│   ├── client.ts             # postgres.js connection (reads DATABASE_URL)
│   └── schema.sql            # DDL: flow_configs, flow_state, executions + indexes
└── types/
    └── index.ts              # FlowManifest, LoadedFlow, Execution, FlowDetail, etc.

flows/
└── email-to-tickets/
    ├── manifest.json         # Flow spec: metadata, requires (services/tools), config schema, state schema
    └── prompt.md             # Agent instructions with {{config.*}} / {{state.*}} template vars

runtime-claude-code/
├── Dockerfile                # Node 20 Alpine + Claude Code CLI
├── package.json              # Runtime dependencies
└── entrypoint.sh             # Runs Claude Code with FLOW_PROMPT

public/
├── index.html                # Dark theme SPA shell
└── app.js                    # Vanilla JS: fetch API + SSE stream reader + dynamic UI

scripts/
└── setup-db.ts               # Runs schema.sql against PostgreSQL
```

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/flows` | Bearer | List all loaded flows |
| `GET` | `/api/flows/:id` | Bearer | Flow detail with service connection status, config, state, last execution |
| `PUT` | `/api/flows/:id/config` | Bearer | Save flow configuration (validated against manifest schema) |
| `POST` | `/api/flows/:id/run` | Bearer | Execute flow — returns SSE stream |
| `GET` | `/api/executions/:id` | Bearer | Get execution status/result |
| `GET` | `/auth/connections` | Bearer | List OAuth connections from Nango |
| `POST` | `/auth/connect/:provider` | Bearer | Create Nango Connect Session (returns `connectLink` for popup) |
| `GET` | `/*` | None | Static files from `public/` |

### SSE Events (POST /api/flows/:id/run)

```
execution_started   → {executionId, startedAt}
dependency_check    → {services: {gmail: "ok", clickup: "ok"}}
adapter_started     → {adapter: "claude-code"}
progress            → {message: "..."}           (repeated)
result              → {summary, tickets_created, ...}
execution_completed → {executionId, status: "success"|"failed"|"timeout"}
```

### Error Codes

`FLOW_NOT_FOUND` (404), `VALIDATION_ERROR` (400), `DEPENDENCY_NOT_SATISFIED` (400), `CONFIG_INCOMPLETE` (400), `EXECUTION_IN_PROGRESS` (409), `UNAUTHORIZED` (401)

## Flow Manifest Format

Each flow is a directory in `flows/` with `manifest.json` + `prompt.md`. See `flows/email-to-tickets/manifest.json` for the reference implementation. Key sections:

- **metadata**: name (kebab-case ID), displayName, description, author, tags
- **requires.services[]**: OAuth services needed — `{id, provider, scopes, description}`
- **requires.tools[]**: Platform tools — `{id, type: "static"|"custom", description}`
- **config.schema**: User-configurable params — `{type, default, required, enum, description}`
- **state.schema**: Persisted state between runs — `{type, format}`
- **execution**: timeout (seconds), maxTokens

## Container Protocol

The Claude Code runtime container streams JSON events on stdout. The `ClaudeCodeAdapter` (`src/services/adapters/claude-code.ts`) parses these events:

- **`assistant` messages** with text content → forwarded as `progress` SSE events
- **`result` messages** → parsed for JSON code blocks containing the final result
- The last ` ```json ``` ` block in assistant text is extracted as the result

The platform reads these lines from Docker log stream (multiplexed format), parses them, and forwards as SSE events. If `result.state` is present, the platform persists it to `flow_state`.

## Environment Variables

```env
LLM_MODEL=claude-sonnet-4-5-20250929
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # Run `claude setup-token` to generate
DATABASE_URL=postgres://openflows:openflows@localhost:5432/openflows
NANGO_URL=http://localhost:3003
NANGO_SECRET_KEY=<uuid-v4>            # Must be UUID v4 format
NANGO_ENCRYPTION_KEY=<base64-256bit>  # openssl rand -base64 32 (required for Connect UI)
PORT=3000
DOCKER_SOCKET=/var/run/docker.sock
AUTH_TOKEN=dev-token-openflows     # Omit to disable auth (dev mode)
```

## Known Issues & Technical Debt

1. **Duration not computed**: `execution.duration` is never set — need to compute elapsed time between started_at and completed_at in the execution flow.

2. **Nango Connect Session flow**: OAuth uses Connect Session Tokens (created server-side via `nango.createConnectSession()`). The frontend opens `connectLink` in a popup. The `NANGO_SECRET_KEY_DEV` env var seeds Nango's dev environment key — if this doesn't work, check the Nango DB for the auto-generated secret key.

3. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous `stream: false` mode that returns the full result as JSON — not yet implemented. The request body accepts `stream?: boolean` but it's ignored.

4. **Prompt interpolation is basic**: The `{{#if}}` blocks only support `state.*` variables. No filter support (e.g. `| default:`). No flows currently use filters so this is theoretical.

5. **UI auth token**: The UI reads `localStorage.getItem("openflows_token")` but there's no UI to set it. If `AUTH_TOKEN` is configured, the UI will fail silently. Needs a token input prompt.

## What's Validated

- `bun run dev` starts successfully and loads flows from `flows/` directory
- `GET /api/flows` returns the email-to-tickets flow with correct structure
- Auth middleware blocks unauthenticated requests to `/api/*`
- Static file serving works for `public/index.html` and `public/app.js`

## What's NOT Yet Tested End-to-End

- Docker Compose (postgres + nango) full startup
- Nango OAuth flow with real Gmail/ClickUp credentials
- Container creation, execution, and log streaming
- SSE streaming from container stdout to browser
- State persistence between executions
- The UI connected to a real running instance with all services

## Detailed Specs

The full product specifications are in the Obsidian vault at:
```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
