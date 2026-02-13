# Appstrate — Developer Guide

Appstrate is an open-source platform for executing one-shot AI flows in ephemeral Docker containers. A user signs up, connects OAuth/API key services (Gmail, ClickUp, Brevo), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Flows can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

## Quick Start

```sh
# 1. Start infrastructure
docker compose up -d          # PostgreSQL 16 + Redis + Nango (OAuth/API key management)

# 2. Start Supabase (local dev)
bunx supabase start           # Runs migrations automatically from supabase/migrations/

# 3. Setup Nango integrations (optional — creates OAuth + API key integrations)
bun run setup-nango           # Idempotent: safe to run multiple times

# 4. Build runtime image
bun run build-runtime         # docker build -t appstrate-claude-code ./runtime-claude-code

# 5. Configure .env (copy .env.example, set CLAUDE_CODE_OAUTH_TOKEN + Supabase keys)

# 6. Build everything (shared-types + frontend)
bun run build                 # turbo build → apps/web/dist/

# 7. Start platform (API + Vite build --watch in parallel)
bun run dev                   # turbo dev → Hono on :3000

# 8. First signup becomes admin automatically
```

## Stack & Conventions

| Layer             | Technology                                        | Notes                                                                       |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------------- |
| Monorepo          | **Turborepo** + Bun workspaces                    | Single `bun install`, task caching, parallel execution                      |
| Runtime           | **Bun**                                           | Use `bun` everywhere, not node. Bun auto-loads `.env`                       |
| API               | **Hono**                                          | NOT `Bun.serve()` — we need Hono for SSE (`streamSSE`), routing, middleware |
| DB                | **Supabase** (`@supabase/supabase-js`)            | Typed client with generated types. Backend uses service role key            |
| Auth              | **Supabase Auth** (email/password + JWT)          | Multi-user with profiles table and RLS. First signup = admin                |
| OAuth/API keys    | **Nango** self-hosted (`@nangohq/node`)           | Manages OAuth (Gmail, ClickUp) + API key (Brevo) integrations               |
| Validation        | **Zod**                                           | Manifest, config, input, output validation via `services/schema.ts`         |
| Scheduling        | **croner** (cron library)                         | In-memory cron jobs with DB persistence (`flow_schedules` table)            |
| ZIP import        | **fflate** (decompression)                        | User flow import from ZIP files                                             |
| Docker            | **Docker Engine API** via `fetch()` + unix socket | NOT dockerode (socket bugs with Bun)                                        |
| Container runtime | **Claude Code CLI** in Node 20 Alpine             | Uses `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`)                  |
| Frontend          | **React 19 + Vite + React Query v5**              | `apps/web/`, React Router v7 HashRouter, builds to `apps/web/dist/`         |
| Real-time         | **Supabase Realtime** (postgres_changes)          | Execution status via CDC. Logs via React Query polling (1s)                 |
| Type generation   | **Supabase CLI**                                  | `bun run gen:types` → `packages/shared-types/src/database.ts`              |

### Key Patterns

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`apps/api/src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Template interpolation**: `{{config.*}}`, `{{state.*}}`, `{{input.*}}`, `{{#if state.*}}...{{/if}}` in prompt.md files. Implemented in `interpolatePrompt()` in `apps/api/src/routes/executions.ts`.
- **Credential injection**: OAuth/API key tokens passed as env vars (`TOKEN_GMAIL`, `TOKEN_BREVO_API_KEY`) to the container. Built by `env-builder.ts`.
- **Shared types**: Types used by both API and frontend live in `packages/shared-types/`. Generated from Supabase schema (`database.ts`) + manual interfaces (`index.ts`). Backend re-exports them from `apps/api/src/types/index.ts`.
- **Supabase Realtime**: Execution status changes are delivered via Supabase Realtime (`postgres_changes` on `executions` table). Execution logs use React Query polling (1s while running) because Realtime doesn't deliver `execution_logs` INSERTs reliably due to the subquery-based RLS policy on that table.
- **Output validation with retry**: When a flow defines `output.schema`, the platform validates the agent's result with Zod. On mismatch, it sends a retry prompt to the container (up to `execution.outputRetries` times, default 2).
- **DB as single source of truth**: All flows (built-in + user-imported) live in the `flows` DB table. Built-in flows are seeded from `flows/` directory at startup via `flow-seeder.ts`. Skills are passed to containers via `FLOW_SKILLS` env var (JSON), reconstructed by the entrypoint.
- **Nango auth modes**: Integrations can be OAuth2 (popup flow) or API_KEY (modal input). The `authMode` is fetched from Nango's provider metadata via `nango.getProvider()` SDK and cached.
- **Agent skills**: Flows can include `skills/{id}/SKILL.md` files with YAML frontmatter. Skills are stored in DB with their content, passed to containers via `FLOW_SKILLS` env var (JSON), and reconstructed by the entrypoint into `/workspace/.claude/skills/`.
- **Multi-user isolation**: All data tables have Row Level Security (RLS). Users see only their own executions, state, and schedules. Admins see everything. Flow configs and flows are readable by all authenticated users, writable by admins only. Built-in flows are protected from deletion via RLS.
- **Auth flow**: Frontend uses `@supabase/supabase-js` with anon key → `supabase.auth.signInWithPassword()` → JWT stored in Supabase session → sent as `Authorization: Bearer {jwt}` on all API calls. Backend verifies JWT via `supabase.auth.getUser(token)` with service role key.

## Architecture

```
User Browser (hash-based SPA)    Platform (Bun + Hono :3000)
     |                                |
     |-- Login/Signup --------------->|-- Supabase Auth (email/password → JWT)
     |                                |
     |-- #/ (Flow List) ------------->|-- GET /api/flows (with runningExecutions count)
     |-- #/flows/:id (Flow Detail) -->|-- GET /api/flows/:id (with services, config, state, skills)
     |-- PUT /api/flows/:id/config -->|-- schema.ts (Zod validation) → state.ts (Supabase)
     |-- POST /auth/connect/:prov --->|-- nango.ts → createConnectSession() → Nango (:3003)
     |-- POST /auth/connect/:p/api-key|-- nango.ts → createApiKeyConnection() → Nango
     |                                |
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps, config, input (Zod)
     |                                |-- 2. Create execution record (pending, user_id)
     |                                |-- 3. Fire-and-forget: executeFlowInBackground()
     |                                |-- 4. Output validation loop (if output schema)
     |<-- SSE (replay + live) --------|-- 5. Subscribe to logs via pub/sub
     |                                |
     |   Supabase Realtime:           |-- postgres_changes on executions table
     |   (execution status updates)   |-- Frontend subscribes via useExecutionRealtime()
     |                                |
     |   React Query Polling (1s):    |-- Logs polled while execution is running
     |   (execution logs)             |-- Stops when execution completes
     |                                |
     |   Background Execution:        |-- Runs independently of SSE client
     |                                |-- Persists logs to execution_logs table
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
     |-- DELETE /api/flows/:id ------->|-- user-flows.ts: delete user flow + cascade cleanup (source='user' only)
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
├── docker-compose.yml                # PostgreSQL 16 + Redis + Nango
├── CLAUDE.md
│
├── supabase/
│   └── migrations/
│       └── 001_initial.sql           # Schema with multi-user support, RLS policies, Realtime publication
│
├── apps/
│   ├── api/                          # @appstrate/api — Backend (Hono + Bun)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── eslint.config.js
│   │   └── src/
│   │       ├── index.ts              # Hono app entry: CORS, Supabase JWT auth middleware, route mounting, scheduler init, graceful shutdown
│   │       ├── lib/
│   │       │   └── supabase.ts       # Supabase client (service role key), getUserProfile(), isAdmin()
│   │       ├── routes/
│   │       │   ├── flows.ts          # GET /api/flows, GET /api/flows/:id, PUT /api/flows/:id/config (admin), DELETE /api/flows/:id/state
│   │       │   ├── executions.ts     # POST /api/flows/:id/run (SSE), GET /api/executions/:id, interpolatePrompt(), executeFlowInBackground()
│   │       │   ├── schedules.ts      # CRUD for /api/schedules and /api/flows/:id/schedules
│   │       │   ├── user-flows.ts     # POST /api/flows/import (admin), POST/PUT/DELETE /api/flows/:id (admin, user flows only)
│   │       │   ├── auth.ts           # Nango routes: GET /auth/connections, POST /auth/connect/:provider, GET /auth/integrations, DELETE /auth/connections/:provider
│   │       │   └── __tests__/
│   │       │       └── execution-retry.test.ts  # Output validation retry tests
│   │       ├── services/
│   │       │   ├── docker.ts         # dockerFetch(), createClaudeCodeContainer, streamLogs, etc.
│   │       │   ├── adapters/
│   │       │   │   ├── types.ts      # ExecutionAdapter interface, ExecutionMessage type
│   │       │   │   ├── index.ts      # getAdapter() factory, re-exports
│   │       │   │   └── claude-code.ts # ClaudeCodeAdapter (prompt enrichment, stream parsing, retry prompt, output schema injection)
│   │       │   ├── nango.ts          # Nango SDK wrapper: getAccessToken, createConnectSession, createApiKeyConnection, getProviderAuthMode, getIntegrationsWithStatus
│   │       │   ├── state.ts          # Supabase CRUD for flow_configs, flow_state, executions, execution_logs tables
│   │       │   ├── flow-seeder.ts    # Seeds built-in flows from flows/ dir into DB at startup (idempotent via content_hash)
│   │       │   ├── flow-loader.ts    # Loads all flows from DB into memory at startup
│   │       │   ├── flow-import.ts    # importFlowFromZip(): unzip, validate manifest, extract skills, persist
│   │       │   ├── user-flows.ts     # DB CRUD for flows table (list, get, insert, update, delete with cascade)
│   │       │   ├── scheduler.ts      # Cron job lifecycle: init, create/update/delete schedules, trigger executions
│   │       │   ├── schema.ts         # Zod validation: validateManifest, validateConfig, validateInput, validateOutput
│   │       │   └── env-builder.ts    # buildContainerEnv(): builds env var map for container (shared between manual + scheduled runs)
│   │       └── types/
│   │           └── index.ts          # Backend-only types (FlowManifest, LoadedFlow, SkillMeta) + re-exports from @appstrate/shared-types
│   │
│   └── web/                          # @appstrate/web — Frontend (React + Vite)
│       ├── package.json
│       ├── tsconfig.json
│       ├── eslint.config.js
│       ├── vite.config.ts            # envDir: "../../" to load VITE_SUPABASE_* from monorepo root
│       ├── index.html
│       └── src/
│           ├── main.tsx              # Root: QueryClientProvider + HashRouter + App
│           ├── app.tsx               # Auth gate (LoginPage if !user), layout with UserMenu (admin badge), nav, <Routes/>
│           ├── styles.css            # All CSS (dark theme)
│           ├── api.ts                # apiFetch(), api(), getAuthHeaders() — JWT from Supabase session
│           ├── lib/
│           │   ├── supabase.ts       # Supabase client (anon key, navigator.locks bypass)
│           │   └── markdown.ts       # escapeHtml, convertMarkdown, truncate, formatDateField
│           ├── hooks/
│           │   ├── use-auth.ts       # useAuth(): login, signup, logout, user, profile, isAdmin (useSyncExternalStore)
│           │   ├── use-flows.ts      # useFlows(), useFlowDetail(flowId)
│           │   ├── use-executions.ts # useExecutions, useExecution, useExecutionLogs (with polling support)
│           │   ├── use-services.ts   # useServices()
│           │   ├── use-schedules.ts  # useSchedules(flowId), useAllSchedules()
│           │   ├── use-mutations.ts  # useSaveConfig, useResetState, useRunFlow, useConnect, useConnectApiKey, useDisconnect, schedule mutations
│           │   └── use-realtime.ts   # Supabase Realtime: useExecutionRealtime (status), useFlowExecutionRealtime, useAllExecutionsRealtime
│           ├── pages/
│           │   ├── login.tsx         # Login/signup form (email + password + display name)
│           │   ├── flow-list.tsx     # #/ — flow cards grid with import button
│           │   ├── flow-detail.tsx   # #/flows/:flowId — config/state/input modals, execution list, service connect (OAuth/API key branching)
│           │   ├── execution-detail.tsx # #/flows/:flowId/executions/:execId — logs (polled) + result + Realtime status
│           │   ├── services-list.tsx # #/services — connect/disconnect integrations (OAuth popup or API key modal)
│           │   └── schedules-list.tsx # #/schedules — manage cron schedules across all flows
│           └── components/
│               ├── modal.tsx         # Generic overlay + escape + click-outside
│               ├── config-modal.tsx  # Config form, useSaveConfig mutation
│               ├── state-modal.tsx   # JSON viewer + useResetState mutation
│               ├── input-modal.tsx   # Input form before run
│               ├── import-modal.tsx  # ZIP file upload for flow import
│               ├── api-key-modal.tsx # API key input for non-OAuth integrations (Brevo, etc.)
│               ├── schedule-modal.tsx # Create/edit cron schedule form
│               ├── schedule-row.tsx  # Schedule row with enable/disable/delete
│               ├── form-field.tsx    # Reusable labeled form field component
│               ├── log-viewer.tsx    # Log entries with type-based styling + auto-scroll
│               ├── result-renderer.tsx # Full result render pipeline
│               ├── error-boundary.tsx # React error boundary wrapper
│               ├── badge.tsx         # Status badge with conditional spinner
│               └── spinner.tsx       # <span className="spinner" />
│
├── packages/
│   └── shared-types/                 # @appstrate/shared-types — Types used by both apps
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── database.ts           # Auto-generated Supabase types (bun run gen:types)
│           └── index.ts              # Re-exports Database types + manual interfaces (FlowDetail, Integration, etc.)
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
├── runtime-claude-code/              # Docker image for Claude Code CLI
│   ├── Dockerfile
│   └── entrypoint.sh
│
└── scripts/
    └── setup-nango.ts                # Creates Nango integrations (OAuth + API key) and pre-connects API key services
```

## API Endpoints

### Flows

| Method   | Path                          | Auth      | Description                                                                     |
| -------- | ----------------------------- | --------- | ------------------------------------------------------------------------------- |
| `GET`    | `/api/flows`                  | JWT       | List all flows (built-in + user) with `runningExecutions` count, `source` field |
| `GET`    | `/api/flows/:id`              | JWT       | Flow detail with service statuses (incl. `authMode`), config, state, skills     |
| `PUT`    | `/api/flows/:id/config`       | JWT+Admin | Save flow configuration (Zod-validated against manifest schema)                 |
| `DELETE` | `/api/flows/:id/state`        | JWT       | Reset flow state                                                                |
| `POST`   | `/api/flows/import`           | JWT+Admin | Import flow from ZIP file (multipart/form-data)                                 |
| `DELETE` | `/api/flows/:id`              | JWT+Admin | Delete a user-imported flow (built-in flows cannot be deleted)                  |

### Executions

| Method | Path                          | Auth   | Description                                                                     |
| ------ | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `POST` | `/api/flows/:id/run`          | JWT    | Execute flow (fire-and-forget) — returns SSE stream (replay + live)             |
| `GET`  | `/api/flows/:id/executions`   | JWT    | List executions for a flow (default limit 50, user-scoped via RLS)              |
| `GET`  | `/api/executions/:id`         | JWT    | Get execution status/result                                                     |
| `GET`  | `/api/executions/:id/logs`    | JWT    | Get persisted logs (pagination via `?after=lastId`)                             |
| `GET`  | `/api/executions/:id/stream`  | JWT    | SSE stream: replays all logs from DB, then streams live updates via pub/sub     |

### Schedules

| Method   | Path                          | Auth   | Description                                                                     |
| -------- | ----------------------------- | ------ | ------------------------------------------------------------------------------- |
| `GET`    | `/api/schedules`              | JWT    | List all schedules across all flows (user-scoped via RLS)                       |
| `GET`    | `/api/flows/:id/schedules`    | JWT    | List schedules for a specific flow                                              |
| `POST`   | `/api/flows/:id/schedules`    | JWT    | Create a cron schedule for a flow                                               |
| `GET`    | `/api/schedules/:id`          | JWT    | Get a single schedule                                                           |
| `PUT`    | `/api/schedules/:id`          | JWT    | Update a schedule (cron, timezone, enabled, input)                              |
| `DELETE` | `/api/schedules/:id`          | JWT    | Delete a schedule                                                               |

### Auth / Integrations (Nango)

| Method   | Path                              | Auth   | Description                                                         |
| -------- | --------------------------------- | ------ | ------------------------------------------------------------------- |
| `GET`    | `/auth/connections`               | JWT    | List active Nango connections (user-scoped via end_user)            |
| `GET`    | `/auth/integrations`              | JWT    | List all integrations with connection status and `authMode`         |
| `POST`   | `/auth/connect/:provider`         | JWT    | Create Nango Connect Session (returns `connectLink` for OAuth popup)|
| `POST`   | `/auth/connect/:provider/api-key` | JWT    | Connect an API key integration (body: `{ apiKey }`)                 |
| `DELETE` | `/auth/connections/:provider`     | JWT    | Disconnect a service                                                |

### Other

| Method | Path | Auth | Description                    |
| ------ | ---- | ---- | ------------------------------ |
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

Managed via Supabase migrations (`supabase/migrations/001_initial.sql`). All tables have Row Level Security (RLS) enabled.

```sql
-- User profiles (extends auth.users, auto-created on signup)
-- First user gets role='admin', subsequent users get role='user'
profiles (id UUID PK→auth.users, display_name, role CHECK('admin','user'), created_at, updated_at)
  -- RLS: all read, own update

-- Flow configuration (global, admin-only write)
flow_configs (flow_id PK, config JSONB, created_at, updated_at)
  -- RLS: all authenticated read, admin write

-- Flow persistent state (per-user, updated between runs)
flow_state (user_id UUID + flow_id PK, state JSONB, updated_at)
  -- RLS: own data + admin sees all

-- Execution records (per-user)
executions (id PK, flow_id, user_id UUID, status, input JSONB, result JSONB, error, tokens_used, started_at, completed_at, duration, schedule_id)
  -- Indexes: flow_id, status, user_id
  -- RLS: own data + admin sees all

-- Execution log entries
execution_logs (id SERIAL PK, execution_id FK→executions ON DELETE CASCADE, type, event, message, data JSONB, created_at)
  -- Indexes: execution_id, (execution_id, id)
  -- RLS: via subquery on executions (user_id) + admin sees all

-- Cron schedules (per-user)
flow_schedules (id PK, flow_id, user_id UUID, name, enabled, cron_expression, timezone, input JSONB, last_run_at, next_run_at, created_at, updated_at)
  -- Indexes: flow_id, user_id
  -- RLS: own data + admin sees all

-- All flows: built-in (seeded at startup) + user-imported
flows (id PK, manifest JSONB, prompt TEXT, skills JSONB, source TEXT, content_hash TEXT, created_at, updated_at)
  -- RLS: all authenticated read, admin write, delete restricted to source='user'
```

Supabase Realtime publishes `executions` and `execution_logs` tables.

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

# Supabase (cloud or self-hosted)
SUPABASE_URL=http://localhost:8000          # or https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJ...                    # Public key (frontend + backend)
SUPABASE_SERVICE_ROLE_KEY=eyJ...            # Secret key (backend only — bypasses RLS)

# Frontend Supabase (Vite env vars — loaded from monorepo root via envDir)
VITE_SUPABASE_URL=http://localhost:8000
VITE_SUPABASE_ANON_KEY=eyJ...

# Nango (OAuth/API key management)
NANGO_URL=http://localhost:3003
NANGO_SECRET_KEY=<uuid-v4>            # Must be UUID v4 format
NANGO_ENCRYPTION_KEY=<base64-256bit>  # openssl rand -base64 32 (required for Connect UI)

# Platform
PORT=3000
DOCKER_SOCKET=/var/run/docker.sock
```

## Known Issues & Technical Debt

1. **Nango secret key mismatch**: The `NANGO_SECRET_KEY` in `.env` may differ from the actual key in Nango's DB (`_nango_environments` table). The `@nangohq/node` SDK handles this mapping internally, but raw `fetch()` calls to the Nango REST API need the actual DB key. Always use the SDK when possible.

2. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous `stream: false` mode that returns the full result as JSON — not yet implemented. The request body accepts `stream?: boolean` but it's ignored.

3. **Prompt interpolation is basic**: The `{{#if}}` blocks only support `state.*` variables. No filter support (e.g. `| default:`). No flows currently use filters so this is theoretical.

4. **Scheduler is in-memory**: Cron jobs run in-process via `croner`. If the server restarts, jobs are re-loaded from DB on startup. No distributed locking — not safe for multi-instance deployments.

5. **Execution logs Realtime**: Supabase Realtime doesn't deliver `execution_logs` INSERTs due to the subquery-based RLS policy. Workaround: React Query polling at 1s interval while execution is running. The `executions` table (simple `user_id = auth.uid()` policy) works fine with Realtime.

6. **Supabase client navigator.locks bypass**: The frontend Supabase client bypasses `navigator.locks` to avoid a deadlock during session refresh. This is a workaround cast with `as any` in `apps/web/src/lib/supabase.ts`.

## What's Validated

- `turbo build` builds shared-types + frontend successfully
- `turbo lint` passes for both apps with cache support
- `turbo dev` runs API + Vite build --watch in parallel
- `GET /api/flows` returns flows with correct structure (built-in + user sources)
- Supabase JWT auth middleware blocks unauthenticated requests to `/api/*` and `/auth/*`
- Multi-user isolation via RLS (users see own data, admins see all)
- First signup becomes admin, subsequent signups become regular users
- Login/signup flow with email + password
- Static file serving works for `apps/web/dist/`
- Nango OAuth flow (Gmail, ClickUp, Google Calendar) with Connect Session Tokens
- Nango API key flow (Brevo) — `authMode` detection + API key modal
- Nango connections scoped per user (end_user.id filtering)
- ZIP flow import with manifest validation, skill extraction, and in-memory hot-reload
- Cron schedule CRUD with `croner` validation
- Output schema validation with Zod and retry loop (unit tested)
- Supabase Realtime for execution status updates
- React Query polling (1s) for execution logs during running executions

## Detailed Specs

The full product specifications are in the Obsidian vault at:

```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
