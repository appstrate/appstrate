# Appstrate — Developer Guide

Appstrate is an open-source platform for executing one-shot AI flows in ephemeral Docker containers. A user deploys via Docker Compose, connects OAuth/API key services (Gmail, ClickUp, Brevo), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Flows can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

## Quick Start

```sh
# 1. Start infrastructure
docker compose up -d          # PostgreSQL 16 + Nango (OAuth/API key management)

# 2. Init database
bun run setup-db              # Creates tables in PostgreSQL

# 3. Setup Nango integrations (optional — creates OAuth + API key integrations)
bun run setup-nango           # Idempotent: safe to run multiple times

# 4. Build runtime image
bun run build-runtime         # docker build -t appstrate-claude-code ./runtime-claude-code

# 5. Configure .env (copy .env.example, set CLAUDE_CODE_OAUTH_TOKEN)

# 6. Build everything (shared-types + frontend)
bun run build                 # turbo build → apps/web/dist/

# 7. Start platform (API + Vite build --watch in parallel)
bun run dev                   # turbo dev → Hono on :3000
```

## Stack & Conventions

| Layer             | Technology                                        | Notes                                                                       |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Monorepo          | **Turborepo** + Bun workspaces                    | Single `bun install`, task caching, parallel execution                      |
| Runtime           | **Bun**                                           | Use `bun` everywhere, not node. Bun auto-loads `.env`                       |
| API               | **Hono**                                          | NOT `Bun.serve()` — we need Hono for SSE (`streamSSE`), routing, middleware |
| DB                | **postgres.js** (`postgres` package)              | NOT `Bun.sql` — despite the auto-generated Bun CLAUDE.md suggestion         |
| Auth/OAuth        | **Nango** self-hosted (`@nangohq/node`)           | Manages OAuth (Gmail, ClickUp) + API key (Brevo) integrations               |
| Validation        | **Zod**                                           | Manifest, config, input, output validation via `services/schema.ts`         |
| Scheduling        | **croner** (cron library)                         | In-memory cron jobs with DB persistence (`flow_schedules` table)            |
| ZIP import        | **fflate** (decompression)                        | User flow import from ZIP files                                             |
| Docker            | **Docker Engine API** via `fetch()` + unix socket | NOT dockerode (socket bugs with Bun)                                        |
| Container runtime | **Claude Code CLI** in Node 20 Alpine             | Uses `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)                  |
| Frontend          | **React 19 + Vite + React Query v5**              | `apps/web/`, React Router v7 HashRouter, builds to `apps/web/dist/`         |
| Auth              | Bearer token from `AUTH_TOKEN` env var            | No auth on static files. All `/api/*` and `/auth/*` routes require bearer   |
| Real-time         | **WebSocket** (Hono + Bun)                        | Channel-based pub/sub for live UI updates                                   |

### Key Patterns

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`apps/api/src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Template interpolation**: `{{config.*}}`, `{{state.*}}`, `{{input.*}}`, `{{#if state.*}}...{{/if}}` in prompt.md files. Implemented in `interpolatePrompt()` in `apps/api/src/routes/executions.ts`.
- **Credential injection**: OAuth/API key tokens passed as env vars (`TOKEN_GMAIL`, `TOKEN_BREVO_API_KEY`) to the container. Built by `env-builder.ts`.
- **Shared types**: Types used by both API and frontend live in `packages/shared-types/`. Backend re-exports them from `apps/api/src/types/index.ts`.
- **WebSocket pub/sub**: `ws.ts` manages channel subscriptions. Frontend subscribes via `useWsChannel()` hook. Used for real-time execution status and flow state updates.
- **Output validation with retry**: When a flow defines `output.schema`, the platform validates the agent's result with Zod. On mismatch, it sends a retry prompt to the container (up to `execution.outputRetries` times, default 2).
- **Two flow sources**: Built-in flows from `flows/` directory, and user-imported flows from `user_flows` DB table (materialized to `data/user-flows/` at startup).
- **Nango auth modes**: Integrations can be OAuth2 (popup flow) or API_KEY (modal input). The `authMode` is fetched from Nango's provider metadata via `nango.getProvider()` SDK and cached.
- **Agent skills**: Flows can include `skills/{id}/SKILL.md` files with YAML frontmatter. Skills are listed in flow detail and their content is available to the container agent.

## Architecture

```
User Browser (hash-based SPA)    Platform (Bun + Hono :3000)
     |                                |
     |-- #/ (Flow List) ------------->|-- GET /api/flows (with runningExecutions count)
     |-- #/flows/:id (Flow Detail) -->|-- GET /api/flows/:id (with services, config, state, skills)
     |-- PUT /api/flows/:id/config -->|-- schema.ts (Zod validation) → state.ts (PostgreSQL)
     |-- POST /auth/connect/:prov --->|-- nango.ts → createConnectSession() → Nango (:3003)
     |-- POST /auth/connect/:p/api-key|-- nango.ts → createApiKeyConnection() → Nango
     |                                |
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps, config, input (Zod)
     |                                |-- 2. Create execution record (pending)
     |                                |-- 3. Fire-and-forget: executeFlowInBackground()
     |                                |-- 4. Output validation loop (if output schema)
     |<-- SSE (replay + live) --------|-- 5. Subscribe to logs via pub/sub
     |                                |
     |-- WS /ws ----------------------|-- Channel pub/sub (subscribe, ping/pong)
     |                                |   Channels: flow:{id}, execution:{id}
     |                                |
     |   Background Execution:        |-- Runs independently of SSE client
     |                                |-- Persists logs to execution_logs table
     |                                |-- Broadcasts to WS + in-memory subscribers
     |                                |-- Supports concurrent executions per flow
     |                                |
     |   Scheduler (croner):          |-- Loads enabled schedules from DB at startup
     |                                |-- Cron triggers → triggerScheduledExecution()
     |                                |-- Uses same executeFlowInBackground() path
     |                                |
     |-- #/flows/:id/executions/:eid->|
     |   (Execution Detail)           |
     |-- GET /api/executions/:id/stream (SSE: replay DB + live via pub/sub)
     |-- GET /api/executions/:id/logs  (REST: paginated historical logs)
     |                                |
     |-- POST /api/flows/import ------>|-- flow-import.ts: unzip, validate manifest, persist to DB
     |-- DELETE /api/flows/:id ------->|-- user-flows.ts: delete user flow + cascade cleanup
     |                                |
     |-- #/schedules (Schedules List)->|-- GET /api/schedules, CRUD per flow
     |-- #/services (Services List) -->|-- GET /auth/integrations (with authMode)
     |                                |
     |            Ephemeral Container (Claude Code CLI)
     |            - Receives: FLOW_PROMPT, TOKEN_*, CONFIG_*, INPUT_*, CLAUDE_CODE_OAUTH_TOKEN
     |            - Claude Code executes the prompt with access to bash/tools
     |            - Outputs JSON lines on stdout (parsed by ClaudeCodeAdapter)
     |            - Skills available as files in the container
```

## Project Structure

```
appstrate/
├── turbo.json                        # Turborepo task pipeline config
├── package.json                      # Root: workspaces, turbo scripts
├── .prettierrc                       # Shared Prettier config
├── docker-compose.yml
├── CLAUDE.md
│
├── apps/
│   ├── api/                          # @appstrate/api — Backend (Hono + Bun)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── eslint.config.js
│   │   └── src/
│   │       ├── index.ts              # Hono app entry: CORS, auth middleware, WS, route mounting, scheduler init, graceful shutdown
│   │       ├── ws.ts                 # WebSocket channel pub/sub manager (subscribe/broadcast)
│   │       ├── routes/
│   │       │   ├── flows.ts          # GET /api/flows, GET /api/flows/:id, PUT /api/flows/:id/config, DELETE /api/flows/:id/state
│   │       │   ├── executions.ts     # POST /api/flows/:id/run (SSE), GET /api/executions/:id, interpolatePrompt(), executeFlowInBackground()
│   │       │   ├── schedules.ts      # CRUD for /api/schedules and /api/flows/:id/schedules
│   │       │   ├── user-flows.ts     # POST /api/flows/import (ZIP upload), DELETE /api/flows/:id (user flows only)
│   │       │   ├── auth.ts           # GET /auth/connections, POST /auth/connect/:provider, POST /auth/connect/:provider/api-key, GET /auth/integrations, DELETE /auth/connections/:provider
│   │       │   └── __tests__/
│   │       │       └── execution-retry.test.ts  # Output validation retry tests
│   │       ├── services/
│   │       │   ├── docker.ts         # dockerFetch(), createClaudeCodeContainer, streamLogs, etc.
│   │       │   ├── adapters/
│   │       │   │   ├── types.ts      # ExecutionAdapter interface, ExecutionMessage type
│   │       │   │   ├── index.ts      # getAdapter() factory, re-exports
│   │       │   │   └── claude-code.ts # ClaudeCodeAdapter (prompt enrichment, stream parsing, retry prompt, output schema injection)
│   │       │   ├── nango.ts          # Nango SDK wrapper: getAccessToken, createConnectSession, createApiKeyConnection, getProviderAuthMode, getIntegrationsWithStatus
│   │       │   ├── state.ts          # CRUD for flow_configs, flow_state, executions, execution_logs tables
│   │       │   ├── flow-loader.ts    # Scans flows/ dir + loads user flows from DB at startup, validates manifests with Zod
│   │       │   ├── flow-import.ts    # importFlowFromZip(): unzip, validate manifest, extract skills, persist
│   │       │   ├── flow-materializer.ts # Materializes user flows from DB to filesystem (data/user-flows/)
│   │       │   ├── user-flows.ts     # DB CRUD for user_flows table (list, get, insert, delete with cascade)
│   │       │   ├── scheduler.ts      # Cron job lifecycle: init, create/update/delete schedules, trigger executions
│   │       │   ├── schema.ts         # Zod validation: validateManifest, validateConfig, validateInput, validateOutput
│   │       │   └── env-builder.ts    # buildContainerEnv(): builds env var map for container (shared between manual + scheduled runs)
│   │       ├── db/
│   │       │   ├── client.ts         # postgres.js connection (reads DATABASE_URL)
│   │       │   └── schema.sql        # DDL: flow_configs, flow_state, executions, execution_logs, flow_schedules, user_flows
│   │       └── types/
│   │           └── index.ts          # Backend-only types (FlowManifest, LoadedFlow, SkillMeta) + re-exports from @appstrate/shared-types
│   │
│   └── web/                          # @appstrate/web — Frontend (React + Vite)
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
│           │   ├── use-schedules.ts  # useSchedules(flowId), useAllSchedules()
│           │   ├── use-mutations.ts  # useSaveConfig, useResetState, useRunFlow, useConnect, useConnectApiKey, useDisconnect, schedule mutations
│           │   └── use-websocket.ts  # Module-level WS singleton + useWsChannel() hook for real-time updates
│           ├── pages/
│           │   ├── flow-list.tsx     # #/ — flow cards grid with import button
│           │   ├── flow-detail.tsx   # #/flows/:flowId — config/state/input modals, execution list, service connect (OAuth/API key branching)
│           │   ├── execution-detail.tsx # #/flows/:flowId/executions/:execId — logs/result
│           │   ├── services-list.tsx # #/services — connect/disconnect integrations (OAuth popup or API key modal)
│           │   └── schedules-list.tsx # #/schedules — manage cron schedules across all flows
│           ├── components/
│           │   ├── modal.tsx         # Generic overlay + escape + click-outside
│           │   ├── config-modal.tsx  # Config form, useSaveConfig mutation
│           │   ├── state-modal.tsx   # JSON viewer + useResetState mutation
│           │   ├── input-modal.tsx   # Input form before run
│           │   ├── import-modal.tsx  # ZIP file upload for flow import
│           │   ├── api-key-modal.tsx # API key input for non-OAuth integrations (Brevo, etc.)
│           │   ├── schedule-modal.tsx # Create/edit cron schedule form
│           │   ├── schedule-row.tsx  # Schedule row with enable/disable/delete
│           │   ├── form-field.tsx    # Reusable labeled form field component
│           │   ├── log-viewer.tsx    # Log entries with type-based styling + auto-scroll
│           │   ├── result-renderer.tsx # Full result render pipeline
│           │   ├── error-boundary.tsx # React error boundary wrapper
│           │   ├── badge.tsx         # Status badge with conditional spinner
│           │   └── spinner.tsx       # <span className="spinner" />
│           └── lib/
│               └── markdown.ts       # escapeHtml, convertMarkdown, truncate, formatDateField
│
├── packages/
│   └── shared-types/                 # @appstrate/shared-types — Types used by both apps
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           └── index.ts              # ExecutionStatus, Execution, FlowDetail, Integration, Schedule, FlowInputField, FlowOutputField, etc.
│
├── flows/                            # Built-in flow definitions (loaded at runtime)
│   ├── clickup-summary/
│   ├── email-summary/
│   ├── email-to-tickets/
│   ├── meeting-prep/
│   ├── newsletter-search/
│   └── skill-test/
│       ├── manifest.json             # Flow spec: metadata, requires, config/state/input/output schema, execution settings
│       ├── prompt.md                 # Agent instructions with {{config.*}} / {{state.*}} / {{input.*}} vars
│       └── skills/                   # Optional: agent skills
│           └── {skill-id}/
│               └── SKILL.md          # Skill definition with YAML frontmatter (description)
│
├── data/                             # Runtime data (gitignored)
│   └── user-flows/                   # Materialized user flows from DB
│
├── runtime-claude-code/              # Docker image for Claude Code CLI
│   ├── Dockerfile
│   └── entrypoint.sh
│
└── scripts/
    ├── setup-db.ts                   # Runs schema.sql against PostgreSQL
    └── setup-nango.ts                # Creates Nango integrations (OAuth + API key) and pre-connects API key services
```

## API Endpoints

### Flows

| Method   | Path                          | Auth   | Description                                                                     |
| -------- | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `GET`    | `/api/flows`                  | Bearer | List all flows (built-in + user) with `runningExecutions` count, `source` field |
| `GET`    | `/api/flows/:id`              | Bearer | Flow detail with service statuses (incl. `authMode`), config, state, skills     |
| `PUT`    | `/api/flows/:id/config`       | Bearer | Save flow configuration (Zod-validated against manifest schema)                 |
| `DELETE` | `/api/flows/:id/state`        | Bearer | Reset flow state                                                                |
| `POST`   | `/api/flows/import`           | Bearer | Import flow from ZIP file (multipart/form-data)                                 |
| `DELETE` | `/api/flows/:id`              | Bearer | Delete a user-imported flow (built-in flows cannot be deleted)                  |

### Executions

| Method | Path                          | Auth   | Description                                                                     |
| ------ | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `POST` | `/api/flows/:id/run`          | Bearer | Execute flow (fire-and-forget) — returns SSE stream (replay + live)             |
| `GET`  | `/api/flows/:id/executions`   | Bearer | List executions for a flow (default limit 50)                                   |
| `GET`  | `/api/executions/:id`         | Bearer | Get execution status/result                                                     |
| `GET`  | `/api/executions/:id/logs`    | Bearer | Get persisted logs (pagination via `?after=lastId`)                             |
| `GET`  | `/api/executions/:id/stream`  | Bearer | SSE stream: replays all logs from DB, then streams live updates via pub/sub     |

### Schedules

| Method   | Path                          | Auth   | Description                                                                     |
| -------- | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `GET`    | `/api/schedules`              | Bearer | List all schedules across all flows                                             |
| `GET`    | `/api/flows/:id/schedules`    | Bearer | List schedules for a specific flow                                              |
| `POST`   | `/api/flows/:id/schedules`    | Bearer | Create a cron schedule for a flow                                               |
| `GET`    | `/api/schedules/:id`          | Bearer | Get a single schedule                                                           |
| `PUT`    | `/api/schedules/:id`          | Bearer | Update a schedule (cron, timezone, enabled, input)                              |
| `DELETE` | `/api/schedules/:id`          | Bearer | Delete a schedule                                                               |

### Auth / Integrations

| Method   | Path                              | Auth   | Description                                                         |
| -------- | --------------------------------- | ------ | ------------------------------------------------------------------- |
| `GET`    | `/auth/connections`               | Bearer | List active Nango connections                                       |
| `GET`    | `/auth/integrations`              | Bearer | List all integrations with connection status and `authMode`         |
| `POST`   | `/auth/connect/:provider`         | Bearer | Create Nango Connect Session (returns `connectLink` for OAuth popup)|
| `POST`   | `/auth/connect/:provider/api-key` | Bearer | Connect an API key integration (body: `{ apiKey }`)                 |
| `DELETE` | `/auth/connections/:provider`     | Bearer | Disconnect a service                                                |

### Other

| Method | Path | Auth | Description                    |
| ------ | ---- | ---- | ------------------------------ |
| `WS`   | `/ws` | Query param `token` | WebSocket for real-time channel pub/sub |
| `GET`  | `/*` | None | Static files from `apps/web/dist/` |

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

`FLOW_NOT_FOUND` (404), `VALIDATION_ERROR` (400), `DEPENDENCY_NOT_SATISFIED` (400), `CONFIG_INCOMPLETE` (400), `EXECUTION_IN_PROGRESS` (409), `UNAUTHORIZED` (401), `NAME_COLLISION` (400), `MISSING_MANIFEST` (400), `INVALID_MANIFEST` (400), `ZIP_INVALID` (400), `FILE_TOO_LARGE` (400), `MISSING_PROMPT` (400), `OPERATION_NOT_ALLOWED` (403), `FLOW_IN_USE` (409), `API_KEY_CONNECTION_FAILED` (500), `CONNECT_SESSION_FAILED` (500)

## Database Schema

```sql
-- Flow configuration (user-set params)
flow_configs (flow_id PK, config JSONB, created_at, updated_at)

-- Flow persistent state (updated between runs)
flow_state (flow_id PK, state JSONB, updated_at)

-- Execution records
executions (id PK, flow_id, status, input JSONB, result JSONB, error, tokens_used, started_at, completed_at, duration, schedule_id)
  -- Indexes: flow_id, status

-- Execution log entries
execution_logs (id SERIAL PK, execution_id FK→executions, type, event, message, data JSONB, created_at)
  -- Indexes: execution_id, (execution_id, id)

-- Cron schedules
flow_schedules (id PK, flow_id, name, enabled, cron_expression, timezone, input JSONB, last_run_at, next_run_at, created_at, updated_at)
  -- Indexes: flow_id

-- User-imported flows (persisted in DB, materialized to filesystem)
user_flows (id PK, manifest JSONB, prompt TEXT, skills JSONB, created_at, updated_at)
```

## Flow Manifest Format

Each flow is a directory with `manifest.json` + `prompt.md` + optional `skills/`. See `flows/email-to-tickets/manifest.json` for the reference implementation. Key sections:

- **metadata**: name (kebab-case ID), displayName, description, author, tags
- **requires.services[]**: Services needed — `{id, provider, description, scopes?}` (scopes optional, omit for API key integrations)
- **requires.tools[]**: Platform tools — `{id, type: "static"|"custom", description}`
- **input.schema**: Per-execution user input — `{type, description, required, default, placeholder}`
- **output.schema**: Expected result fields — `{type, description, required}`. Enables Zod validation + retry loop.
- **config.schema**: User-configurable params — `{type, default, required, enum, description}`
- **state.schema**: Persisted state between runs — `{type, format}`
- **execution**: `timeout` (seconds), `maxTokens`, `outputRetries` (0-5, default 2 when output schema exists)

### Skills

Flows can include agent skills in `skills/{skill-id}/SKILL.md`. The SKILL.md file has YAML frontmatter with a `description` field. Skills are listed in the flow detail API response and their content is available inside the execution container.

## Container Protocol

The Claude Code runtime container streams JSON events on stdout. The `ClaudeCodeAdapter` (`apps/api/src/services/adapters/claude-code.ts`) parses these events:

- **`assistant` messages** with text content → forwarded as `progress` SSE events
- **`result` messages** → parsed for JSON code blocks containing the final result
- The last ` ```json ``` ` block in assistant text is extracted as the result

The adapter enriches the flow prompt with: API access instructions (per-service token usage), user input, configuration, previous state, and output format requirements (with field-level schema if defined).

**Output validation loop**: When `output.schema` is defined in the manifest, the platform validates the extracted result with Zod (`validateOutput()`). On mismatch, it builds a retry prompt via `buildRetryPrompt()` describing the errors and expected schema, then re-executes the container. This repeats up to `execution.outputRetries` times. If validation still fails, the result is accepted as-is with a warning.

If `result.state` is present, the platform persists it to `flow_state`.

## Environment Variables

```env
LLM_MODEL=claude-sonnet-4-5-20250929
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # Run `claude setup-token` to generate
DATABASE_URL=postgres://appstrate:appstrate@localhost:5432/appstrate
NANGO_URL=http://localhost:3003
NANGO_SECRET_KEY=<uuid-v4>            # Must be UUID v4 format
NANGO_ENCRYPTION_KEY=<base64-256bit>  # openssl rand -base64 32 (required for Connect UI)
PORT=3000
DOCKER_SOCKET=/var/run/docker.sock
AUTH_TOKEN=dev-token-appstrate     # Omit to disable auth (dev mode)
```

## Known Issues & Technical Debt

1. **Nango secret key mismatch**: The `NANGO_SECRET_KEY` in `.env` may differ from the actual key in Nango's DB (`_nango_environments` table). The `@nangohq/node` SDK handles this mapping internally, but raw `fetch()` calls to the Nango REST API need the actual DB key. Always use the SDK when possible.

2. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous `stream: false` mode that returns the full result as JSON — not yet implemented. The request body accepts `stream?: boolean` but it's ignored.

3. **Prompt interpolation is basic**: The `{{#if}}` blocks only support `state.*` variables. No filter support (e.g. `| default:`). No flows currently use filters so this is theoretical.

4. **UI auth token**: The UI reads `localStorage.getItem("appstrate_token")` but there's no UI to set it. If `AUTH_TOKEN` is configured, the UI will fail silently. Needs a token input prompt.

5. **Scheduler is in-memory**: Cron jobs run in-process via `croner`. If the server restarts, jobs are re-loaded from DB on startup. No distributed locking — not safe for multi-instance deployments.

## What's Validated

- `turbo build` builds shared-types + frontend successfully
- `turbo lint` passes for both apps with cache support
- `turbo dev` runs API + Vite build --watch in parallel
- `GET /api/flows` returns flows with correct structure (built-in + user sources)
- Auth middleware blocks unauthenticated requests to `/api/*` and `/auth/*`
- Static file serving works for `apps/web/dist/`
- Nango OAuth flow (Gmail, ClickUp, Google Calendar) with Connect Session Tokens
- Nango API key flow (Brevo) — `authMode` detection + API key modal
- ZIP flow import with manifest validation, skill extraction, and in-memory hot-reload
- Cron schedule CRUD with `croner` validation
- Output schema validation with Zod and retry loop (unit tested)
- WebSocket pub/sub for real-time UI updates

## Detailed Specs

The full product specifications are in the Obsidian vault at:

```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
