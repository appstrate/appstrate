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

# 5. Build everything (shared-types + frontend)
bun run build                 # turbo build → apps/web/dist/

# 6. Start platform (API + Vite build --watch in parallel)
bun run dev                   # turbo dev → Hono on :3000
```

## Stack & Conventions

| Layer             | Technology                                        | Notes                                                                       |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Monorepo          | **Turborepo** + Bun workspaces                    | Single `bun install`, task caching, parallel execution                      |
| Runtime           | **Bun**                                           | Use `bun` everywhere, not node. Bun auto-loads `.env`                       |
| API               | **Hono**                                          | NOT `Bun.serve()` — we need Hono for SSE (`streamSSE`), routing, middleware |
| DB                | **postgres.js** (`postgres` package)              | NOT `Bun.sql` — despite the auto-generated Bun CLAUDE.md suggestion         |
| OAuth             | **Nango** self-hosted (`@nangohq/node`)           | Manages Gmail + ClickUp OAuth tokens                                        |
| Docker            | **Docker Engine API** via `fetch()` + unix socket | NOT dockerode (socket bugs with Bun)                                        |
| Container runtime | **Claude Code CLI** in Node 20 Alpine             | Uses `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)                  |
| Frontend          | **React 19 + Vite + React Query v5**              | `apps/web/`, React Router v7 HashRouter, builds to `apps/web/dist/`         |
| Auth              | Bearer token from `AUTH_TOKEN` env var            | No auth on static files. All `/api/*` and `/auth/*` routes require bearer   |

### Key Patterns

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`apps/api/src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Template interpolation**: `{{config.*}}`, `{{state.*}}`, `{{#if state.*}}...{{/if}}` in prompt.md files. Implemented in `interpolatePrompt()` in `apps/api/src/routes/executions.ts`.
- **Credential injection**: OAuth tokens passed as env vars (`TOKEN_GMAIL`, `TOKEN_CLICKUP`) to the container. MVP simplicity — no proxy pattern.
- **Shared types**: Types used by both API and frontend live in `packages/shared-types/`. Backend re-exports them from `apps/api/src/types/index.ts`.

## Architecture

```
User Browser (hash-based SPA)    Platform (Bun + Hono :3000)
     |                                |
     |-- #/ (Flow List) ------------->|-- GET /api/flows (with runningExecutions count)
     |-- #/flows/:id (Flow Detail) -->|-- GET /api/flows/:id (with runningExecutions count)
     |-- PUT /api/flows/:id/config -->|-- state.ts (PostgreSQL)
     |-- POST /auth/connect/:provider>|-- nango.ts --> createConnectSession() --> Nango (:3003)
     |                                |   returns connectLink for popup --> OAuth
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps & config
     |                                |-- 2. Create execution record (pending)
     |                                |-- 3. Fire-and-forget: executeFlowInBackground()
     |<-- SSE (replay + live) --------|-- 4. Subscribe to logs via pub/sub
     |                                |
     |   Background Execution:        |-- Runs independently of SSE client
     |                                |-- Persists logs to execution_logs table
     |                                |-- Broadcasts to in-memory subscribers
     |                                |-- Supports concurrent executions per flow
     |                                |
     |-- #/flows/:id/executions/:eid->|
     |   (Execution Detail)           |
     |-- GET /api/executions/:id/stream (SSE: replay DB + live via pub/sub)
     |-- GET /api/executions/:id/logs  (REST: paginated historical logs)
     |                                |
     |            Ephemeral Container (Claude Code CLI)
     |            - Receives: FLOW_PROMPT, TOKEN_*, CONFIG_*, CLAUDE_CODE_OAUTH_TOKEN
     |            - Claude Code executes the prompt with access to bash/tools
     |            - Outputs JSON lines on stdout (parsed by ClaudeCodeAdapter)
```

## Project Structure

```
openflows/
├── turbo.json                        # Turborepo task pipeline config
├── package.json                      # Root: workspaces, turbo scripts
├── .prettierrc                       # Shared Prettier config
├── docker-compose.yml
├── CLAUDE.md
│
├── apps/
│   ├── api/                          # @openflows/api — Backend (Hono + Bun)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── eslint.config.js
│   │   └── src/
│   │       ├── index.ts              # Hono app entry. CORS, auth middleware, route mounting, static serving
│   │       ├── ws.ts                 # WebSocket pub/sub manager
│   │       ├── routes/
│   │       │   ├── flows.ts          # GET /api/flows, GET /api/flows/:id, PUT /api/flows/:id/config
│   │       │   ├── executions.ts     # POST /api/flows/:id/run (SSE), GET /api/executions/:id
│   │       │   └── auth.ts           # POST /auth/connect/:provider, GET /auth/connections
│   │       ├── services/
│   │       │   ├── docker.ts         # dockerFetch(), createClaudeCodeContainer, streamLogs, etc.
│   │       │   ├── adapters/
│   │       │   │   ├── types.ts      # ExecutionAdapter interface, ExecutionMessage type
│   │       │   │   ├── index.ts      # getAdapter() factory, re-exports
│   │       │   │   └── claude-code.ts # ClaudeCodeAdapter (prompt enrichment, stream parsing)
│   │       │   ├── nango.ts          # getConnectionStatus, listConnections, getAccessToken
│   │       │   ├── state.ts          # CRUD for flow_configs, flow_state, executions tables
│   │       │   └── flow-loader.ts    # Scans flows/ dir at startup, parses manifest.json + prompt.md
│   │       ├── db/
│   │       │   ├── client.ts         # postgres.js connection (reads DATABASE_URL)
│   │       │   └── schema.sql        # DDL: flow_configs, flow_state, executions + indexes
│   │       └── types/
│   │           └── index.ts          # Backend-only types + re-exports from @openflows/shared-types
│   │
│   └── web/                          # @openflows/web — Frontend (React + Vite)
│       ├── package.json
│       ├── tsconfig.json
│       ├── eslint.config.js
│       ├── vite.config.ts
│       ├── index.html
│       └── src/
│           ├── main.tsx              # Root: QueryClientProvider + HashRouter + App
│           ├── app.tsx               # Layout: header, nav, <Routes/>
│           ├── styles.css            # All CSS (dark theme)
│           ├── api.ts                # apiFetch(), api(), getAuthHeaders()
│           ├── hooks/
│           │   ├── use-flows.ts      # useFlows(), useFlowDetail(flowId)
│           │   ├── use-executions.ts # useExecutions, useExecution, useExecutionLogs
│           │   ├── use-services.ts   # useServices()
│           │   ├── use-mutations.ts  # useSaveConfig, useResetState, useRunFlow, useConnect
│           │   └── use-websocket.ts  # Module-level WS singleton + useWsChannel() hook
│           ├── pages/
│           │   ├── flow-list.tsx     # #/ — flow cards grid
│           │   ├── flow-detail.tsx   # #/flows/:flowId — config/state/input modals + execution list
│           │   ├── execution-detail.tsx # #/flows/:flowId/executions/:execId — logs/result
│           │   └── services-list.tsx # #/services — connect/disconnect integrations
│           ├── components/
│           │   ├── modal.tsx         # Generic overlay + escape + click-outside
│           │   ├── config-modal.tsx  # Config form, useSaveConfig mutation
│           │   ├── state-modal.tsx   # JSON viewer + useResetState mutation
│           │   ├── input-modal.tsx   # Input form before run
│           │   ├── log-viewer.tsx    # Log entries with type-based styling + auto-scroll
│           │   ├── result-renderer.tsx # Full result render pipeline
│           │   ├── badge.tsx         # Status badge with conditional spinner
│           │   └── spinner.tsx       # <span className="spinner" />
│           └── lib/
│               └── markdown.ts       # escapeHtml, convertMarkdown, truncate, formatDateField
│
├── packages/
│   └── shared-types/                 # @openflows/shared-types — Types used by both apps
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts              # ExecutionStatus, Execution, FlowDetail, Integration, etc.
│
├── flows/                            # Flow definitions (loaded at runtime)
│   └── email-to-tickets/
│       ├── manifest.json
│       └── prompt.md
│
├── runtime-claude-code/              # Docker image for Claude Code CLI
│   ├── Dockerfile
│   ├── package.json
│   └── entrypoint.sh
│
└── scripts/
    └── setup-db.ts                   # Runs schema.sql against PostgreSQL
```

## API Endpoints

| Method | Path                          | Auth   | Description                                                                     |
| ------ | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `GET`  | `/api/flows`                  | Bearer | List all loaded flows (with `runningExecutions` count per flow)                 |
| `GET`  | `/api/flows/:id`              | Bearer | Flow detail with service status, config, state, last execution, running count   |
| `PUT`  | `/api/flows/:id/config`       | Bearer | Save flow configuration (validated against manifest schema)                     |
| `POST` | `/api/flows/:id/run`          | Bearer | Execute flow (fire-and-forget) — returns SSE stream (replay + live)             |
| `GET`  | `/api/flows/:id/executions`   | Bearer | List executions for a flow (default limit 50)                                   |
| `GET`  | `/api/executions/:id`         | Bearer | Get execution status/result                                                     |
| `GET`  | `/api/executions/:id/logs`    | Bearer | Get persisted logs for an execution (pagination via `?after=lastId`)            |
| `GET`  | `/api/executions/:id/stream`  | Bearer | SSE stream: replays all logs from DB, then streams live updates via pub/sub     |
| `GET`  | `/auth/connections`       | Bearer | List OAuth connections from Nango                                         |
| `POST` | `/auth/connect/:provider` | Bearer | Create Nango Connect Session (returns `connectLink` for popup)            |
| `GET`  | `/*`                      | None   | Static files from `apps/web/dist/`                                        |

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

The Claude Code runtime container streams JSON events on stdout. The `ClaudeCodeAdapter` (`apps/api/src/services/adapters/claude-code.ts`) parses these events:

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

1. **Nango Connect Session flow**: OAuth uses Connect Session Tokens (created server-side via `nango.createConnectSession()`). The frontend opens `connectLink` in a popup. The `NANGO_SECRET_KEY_DEV` env var seeds Nango's dev environment key — if this doesn't work, check the Nango DB for the auto-generated secret key.

2. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous `stream: false` mode that returns the full result as JSON — not yet implemented. The request body accepts `stream?: boolean` but it's ignored.

3. **Prompt interpolation is basic**: The `{{#if}}` blocks only support `state.*` variables. No filter support (e.g. `| default:`). No flows currently use filters so this is theoretical.

4. **UI auth token**: The UI reads `localStorage.getItem("openflows_token")` but there's no UI to set it. If `AUTH_TOKEN` is configured, the UI will fail silently. Needs a token input prompt.

## What's Validated

- `turbo build` builds shared-types + frontend successfully
- `turbo lint` passes for both apps with cache support
- `turbo dev` runs API + Vite build --watch in parallel
- `GET /api/flows` returns the email-to-tickets flow with correct structure
- Auth middleware blocks unauthenticated requests to `/api/*`
- Static file serving works for `apps/web/dist/`

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
