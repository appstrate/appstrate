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

# 4. Build runtime images
bun run build-runtime         # docker build -t appstrate-pi ./runtime-pi
bun run build-sidecar         # docker build -t appstrate-sidecar ./runtime-pi/sidecar

# 5. Configure .env (copy .env.example, set Pi adapter keys + Supabase keys)

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
| Scheduling        | **croner** (cron library)                         | In-memory cron jobs with DB persistence + distributed locking (`schedule_runs`) |
| ZIP import        | **fflate** (decompression)                        | User flow import from ZIP files                                             |
| Docker            | **Docker Engine API** via `fetch()` + unix socket | NOT dockerode (socket bugs with Bun)                                        |
| Container runtime | **Pi Coding Agent**                                | Uses Pi Coding Agent SDK, supports multiple LLM providers via API keys      |
| Frontend          | **React 19 + Vite + React Query v5**              | `apps/web/`, React Router v7 HashRouter, builds to `apps/web/dist/`         |
| Real-time         | **Supabase Realtime** (postgres_changes)          | Execution status + logs via CDC (denormalized `user_id` on logs)            |
| Type generation   | **Supabase CLI**                                  | `bun run gen:types` → `packages/shared-types/src/database.ts`              |

### Key Patterns

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`apps/api/src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Structured prompt injection**: `buildPromptContext()` in `env-builder.ts` assembles a typed `PromptContext` (raw prompt, tokens, config, previousState, executionApi, input, schemas). `buildEnrichedPrompt()` in `prompt-builder.ts` generates structured sections (`## User Input`, `## Configuration`, `## Previous State`, `## Execution History API`, etc.) enriched with schema metadata (types, descriptions, required), then appends the raw `prompt.md` at the end. No Handlebars — prompts are sent as-is. Only the latest execution's state is injected in the prompt (lightweight). Historical executions are available on demand via the internal API.
- **Credential isolation via sidecar proxy**: Credentials **never enter the agent container**. Each execution launches a sidecar proxy (`appstrate-sidecar`) on an isolated Docker network. The agent calls the sidecar via `curl` with `X-Service` and `X-Target` headers. The sidecar fetches credentials from `GET /internal/credentials/:serviceId`, substitutes `{{variable}}` placeholders in headers and URL, validates the URL against `authorizedUris`, and forwards the full HTTP request (any method, any body) to the target. The agent has no `EXECUTION_TOKEN`, no `PLATFORM_API_URL`, and no route to the host — only `SIDECAR_URL=http://sidecar:8080`. The sidecar also proxies execution history requests. `authorized_uris` restrict which URLs can be called per service (prefix match with `*` wildcard). For Nango services, default `authorizedUris` are derived from `PROVIDER_BASE_URLS` in `adapters/provider-urls.ts`. Custom service credentials are stored in the `custom_service_credentials` table.
- **Shared types**: Types used by both API and frontend live in `packages/shared-types/`. Generated from Supabase schema (`database.ts`) + manual interfaces (`index.ts`). Backend re-exports them from `apps/api/src/types/index.ts`.
- **Supabase Realtime**: Both execution status changes and execution logs are delivered via Supabase Realtime (`postgres_changes` on `executions` and `execution_logs` tables). The `execution_logs` table has a denormalized `user_id` column enabling a direct RLS policy (`auth.uid() = user_id`) that is compatible with Realtime CDC. The frontend uses `useExecutionLogsRealtime` for live log streaming with deduplication against the initial REST fetch.
- **Output validation with retry**: When a flow defines `output.schema`, the platform validates the agent's result with Zod. On mismatch, it sends a retry prompt to the container (up to `execution.outputRetries` times, default 2).
- **FlowService (dual-read)**: Built-in flows are loaded from the `flows/` directory at startup into an immutable `ReadonlyMap` cache. User flows are always read from the `flows` DB table on demand. `flow-service.ts` provides `getFlow()`, `listFlows()`, `getAllFlowIds()` — no mutable singleton Map, safe for horizontal scaling.
- **Flow versioning**: Every create/update of a user flow creates a snapshot in `flow_versions` (auto-incrementing `version_number` per flow via RPC). Executions are tagged with `flow_version_id` for audit trail. Versions are non-blocking (errors caught and logged).
- **Structured logging**: All backend logging uses `lib/logger.ts` which emits JSON to stdout (`{ level, msg, timestamp, ...data }`). No `console.*` calls.
- **Rate limiting**: Token bucket middleware per `method:path:userId`. Applied on `POST /api/flows/:id/run` (20/min), `POST /api/flows/import` (10/min), `POST /api/flows` (10/min).
- **Graceful shutdown**: `execution-tracker.ts` tracks in-flight executions. On SIGTERM/SIGINT: stop scheduler → reject new POST requests → wait in-flight (max 30s) → exit.
- **Nango auth modes**: Integrations can be OAuth2 (popup flow) or API_KEY (modal input). The `authMode` is fetched from Nango's provider metadata via `nango.getProvider()` SDK and cached.
- **Agent skills**: Flows can include `skills/{id}/SKILL.md` files with YAML frontmatter. Skills are declared in `manifest.requires.skills[]`. For user flows, skills are stored inside the flow's ZIP package in Supabase Storage and extracted into the container at runtime.
- **Flow extensions**: Flows can include `extensions/{id}.ts` files that define Pi agent tools (only used by the pi adapter). Built-in extensions ship with the Pi runtime image. For user flows, custom extensions are stored inside the flow's ZIP package in Supabase Storage and extracted into the container at runtime. Declared in `manifest.requires.extensions[]`.
- **Flow packages (ZIP)**: User flows are stored as ZIP packages in Supabase Storage (`flow-packages` bucket). Each version upload contains `manifest.json`, `prompt.md`, and optional `skills/` and `extensions/` directories. The ZIP is mounted into the container and extracted by the entrypoint.
- **Adapter system**: The platform uses an adapter pattern for execution. Currently only the `pi` adapter is active (Pi Coding Agent SDK, supports multiple LLM providers via API keys). The adapter interface is preserved in `adapters/types.ts` to allow adding future adapters. Shared prompt building logic lives in `adapters/prompt-builder.ts`.
- **Multi-user isolation**: All data tables have Row Level Security (RLS). Users see only their own executions, state, and schedules. Admins see everything. Flow configs and user flows are readable by all authenticated users, writable by admins only.
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
     |   Supabase Realtime:           |-- postgres_changes on executions + execution_logs
     |   (status + logs)              |-- useExecutionRealtime() + useExecutionLogsRealtime()
     |                                |
     |   Background Execution:        |-- Runs independently of SSE client
     |                                |-- Persists logs to execution_logs table
     |                                |-- Supports concurrent executions per flow
     |                                |
     |   Scheduler (croner):          |-- Loads enabled schedules from DB at startup
     |                                |-- Cron triggers → triggerScheduledExecution()
     |                                |-- Distributed lock via schedule_runs table
     |                                |-- Uses same executeFlowInBackground() path
     |                                |
     |   Health:                      |-- GET /health (no auth) → healthy/degraded
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
     |            Docker network: appstrate-exec-{execId} (isolated bridge)
     |            ┌─────────────────────────────────────────────┐
     |            │  Sidecar Container (alias: "sidecar")       │
     |            │  - EXECUTION_TOKEN, PLATFORM_API_URL        │
     |            │  - Proxies /proxy → credential injection    │
     |            │  - Proxies /execution-history               │
     |            │  - ExtraHosts → host.docker.internal        │
     |            ├─────────────────────────────────────────────┤
     |            │  Agent Container (Pi Coding Agent)          │
     |            │  - FLOW_PROMPT, LLM_*, SIDECAR_URL          │
     |            │  - NO EXECUTION_TOKEN, NO PLATFORM_API_URL  │
     |            │  - NO ExtraHosts (cannot reach host)        │
     |            │  - Calls sidecar via curl for API access    │
     |            │  - Outputs JSON lines on stdout             │
     |            └─────────────────────────────────────────────┘
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
│       ├── 001_initial.sql           # Full schema: profiles, flow_configs, executions, execution_logs (with user_id), flow_schedules, flows, RLS, Realtime
│       ├── 002_schedule_locks.sql    # schedule_runs table + try_acquire_schedule_lock() for distributed cron
│       ├── 003_flow_versions.sql     # flow_versions table + create_flow_version() RPC + executions.flow_version_id
│       ├── 004_share_tokens.sql      # share_tokens table for one-time public share links
│       └── 005_execution_state.sql   # Add state JSONB to executions, drop flow_state table
│
├── apps/
│   ├── api/                          # @appstrate/api — Backend (Hono + Bun)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── eslint.config.js
│   │   └── src/
│   │       ├── index.ts              # Hono app entry: CORS, JWT auth, health route, shutdown gate, graceful shutdown, scheduler init
│   │       ├── lib/
│   │       │   ├── supabase.ts       # Supabase client (service role key), getUserProfile(), isAdmin()
│   │       │   └── logger.ts         # Structured JSON logger (debug, info, warn, error → stdout)
│   │       ├── middleware/
│   │       │   └── rate-limit.ts     # Token bucket rate limiter per userId (in-memory, auto-cleanup)
│   │       ├── routes/
│   │       │   ├── flows.ts          # GET /api/flows, GET /api/flows/:id, GET /api/flows/:id/versions, PUT /api/flows/:id/config
│   │       │   ├── executions.ts     # POST /api/flows/:id/run (rate-limited), GET /api/executions/:id, executeFlowInBackground()
│   │       │   ├── schedules.ts      # CRUD for /api/schedules and /api/flows/:id/schedules
│   │       │   ├── user-flows.ts     # POST /api/flows/import (rate-limited), POST/PUT/DELETE /api/flows/:id (admin, user flows only)
│   │       │   ├── health.ts         # GET /health (no auth) — DB + flows checks → healthy/degraded
│   │       │   ├── auth.ts           # Nango routes: GET /auth/connections, POST /auth/connect/:provider, GET /auth/integrations, DELETE /auth/connections/:provider
│   │       │   ├── internal.ts      # GET /internal/execution-history, GET /internal/credentials/:serviceId (container-to-host, auth via execution token)
│   │       │   └── __tests__/
│   │       │       └── execution-retry.test.ts  # Output validation retry tests
│   │       ├── services/
│   │       │   ├── docker.ts         # dockerFetch(), createContainer, streamLogs, network ops (createNetwork, connectToNetwork, removeNetwork)
│   │       │   ├── adapters/
│   │       │   │   ├── types.ts      # ExecutionAdapter interface, ExecutionMessage type, PromptContext, TimeoutError
│   │       │   │   ├── index.ts      # getAdapter() factory, re-exports
│   │       │   │   ├── prompt-builder.ts # Shared: buildEnrichedPrompt, extractJsonResult, buildRetryPrompt
│   │       │   │   ├── provider-urls.ts # Provider base URLs, auth config, URI matching, credential field resolution
│   │       │   │   └── pi.ts         # PiAdapter: sidecar orchestration (network + sidecar + agent), stream parsing
│   │       │   ├── nango.ts          # Nango SDK wrapper: getAccessToken, createConnectSession, createApiKeyConnection, getProviderAuthMode, getIntegrationsWithStatus
│   │       │   ├── state.ts          # Supabase CRUD for flow_configs, executions (with state), execution_logs tables
│   │       │   ├── flow-service.ts   # FlowService: built-in cache (ReadonlyMap) + DB reads for user flows (replaces flow-loader.ts)
│   │       │   ├── flow-versions.ts  # Flow versioning: createFlowVersion(), listFlowVersions(), getLatestVersionId(), createVersionAndUpload()
│   │       │   ├── flow-import.ts    # importFlowFromZip(): unzip, validate manifest, extract skills, persist
│   │       │   ├── user-flows.ts     # DB CRUD for user flows table (get, insert, update, delete with cascade)
│   │       │   ├── execution-tracker.ts # In-flight execution tracking for graceful shutdown (track/untrack/waitForInFlight)
│   │       │   ├── scheduler.ts      # Cron job lifecycle with distributed locking (schedule_runs table)
│   │       │   ├── schema.ts         # Zod validation: validateManifest, validateConfig, validateInput, validateOutput
│   │       │   └── env-builder.ts    # buildPromptContext(): builds typed PromptContext from flow data (shared between manual + scheduled + shared runs)
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
│           │   ├── use-executions.ts # useExecutions, useExecution, useExecutionLogs
│           │   ├── use-services.ts   # useServices()
│           │   ├── use-schedules.ts  # useSchedules(flowId), useAllSchedules()
│           │   ├── use-mutations.ts  # useSaveConfig, useResetState, useRunFlow, useConnect, useConnectApiKey, useDisconnect, schedule mutations
│           │   └── use-realtime.ts   # Supabase Realtime: useExecutionRealtime (status), useExecutionLogsRealtime (logs), useFlowExecutionRealtime, useAllExecutionsRealtime
│           ├── pages/
│           │   ├── login.tsx         # Login/signup form (email + password + display name)
│           │   ├── flow-list.tsx     # #/ — flow cards grid with import button
│           │   ├── flow-detail.tsx   # #/flows/:flowId — config/state/input modals, execution list, service connect (OAuth/API key branching)
│           │   ├── execution-detail.tsx # #/flows/:flowId/executions/:execId — logs + result via Realtime
│           │   ├── services-list.tsx # #/services — connect/disconnect integrations (OAuth popup or API key modal)
│           │   └── schedules-list.tsx # #/schedules — manage cron schedules across all flows
│           └── components/
│               ├── modal.tsx         # Generic overlay + escape + click-outside
│               ├── config-modal.tsx  # Config form, useSaveConfig mutation
│               ├── state-modal.tsx   # JSON viewer + useResetState mutation
│               ├── input-modal.tsx   # Input form before run
│               ├── import-modal.tsx  # ZIP file upload for flow import
│               ├── api-key-modal.tsx # API key input for non-OAuth integrations (Brevo, etc.)
│               ├── custom-credentials-modal.tsx # Dynamic credential form for custom services (based on schema)
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
│       ├── prompt.md                 # Agent instructions (appended as-is after structured context sections)
│       ├── skills/                   # Optional: agent skills
│       │   └── {skill-id}/
│       │       └── SKILL.md          # Skill definition with YAML frontmatter (description)
│       └── extensions/               # Optional: Pi agent extensions (TypeScript tools)
│           └── {id}.ts               # Extension file (custom tool for pi adapter)
│
├── runtime-pi/                       # Docker image for Pi Coding Agent SDK
│   ├── Dockerfile
│   ├── package.json
│   ├── entrypoint.ts                 # SDK session → JSON line stdout
│   ├── extensions/                   # Built-in extensions shipped with image
│   │   ├── web-fetch.ts              # Fetch URL content
│   │   └── web-search.ts             # DuckDuckGo web search
│   └── sidecar/                      # Credential-isolating sidecar proxy
│       ├── Dockerfile                # oven/bun:1-slim + hono
│       ├── package.json
│       └── server.ts                 # Transparent HTTP proxy: credential injection, URL validation, body streaming
│
└── scripts/
    └── setup-nango.ts                # Creates Nango integrations (OAuth + API key) and pre-connects API key services
```

## API Endpoints

### Flows

| Method   | Path                          | Auth      | Description                                                                     |
| -------- | ----------------------------- | --------- | ------------------------------------------------------------------------------- |
| `GET`    | `/api/flows`                  | JWT       | List all flows (built-in + user) with `runningExecutions` count                 |
| `GET`    | `/api/flows/:id`              | JWT       | Flow detail with service statuses (incl. `authMode`), config, state, skills     |
| `PUT`    | `/api/flows/:id/config`       | JWT+Admin | Save flow configuration (Zod-validated against manifest schema)                 |
| `POST`   | `/api/flows/import`           | JWT+Admin | Import flow from ZIP file (multipart/form-data)                                 |
| `GET`    | `/api/flows/:id/versions`     | JWT       | List version history for a user flow (newest first)                             |
| `DELETE` | `/api/flows/:id`              | JWT+Admin | Delete a user-imported flow (built-in flows cannot be deleted)                  |
| `POST`   | `/api/flows/:id/services/:svcId/credentials` | JWT | Save custom service credentials (body: `{ credentials }`)          |
| `DELETE`  | `/api/flows/:id/services/:svcId/credentials` | JWT | Delete custom service credentials                                  |

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

### Internal (container-to-host)

| Method | Path                            | Auth              | Description                                                                 |
| ------ | ------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `GET`  | `/internal/execution-history`   | Bearer execId     | Fetch historical executions for the current flow (fields: state, result)    |
| `GET`  | `/internal/credentials/:serviceId` | Bearer execId  | Fetch credentials for a service — returns `{ credentials, authorizedUris }` (Nango or custom) |

### Other

| Method | Path      | Auth | Description                                                              |
| ------ | --------- | ---- | ------------------------------------------------------------------------ |
| `GET`  | `/health` | None | Health check — `{ status: "healthy"\|"degraded", uptime_ms, checks }` |
| `GET`  | `/*`      | None | Static files from `apps/web/dist/`                                       |

### SSE Events (POST /api/flows/:id/run)

```
execution_started   → {executionId, startedAt}
dependency_check    → {services: {gmail: "ok", clickup: "ok"}}
adapter_started     → {adapter: "pi"}
progress            → {message: "..."}           (repeated)
result              → {summary, tickets_created, ...}
execution_completed → {executionId, status: "success"|"failed"|"timeout"}
```

### Error Codes

`FLOW_NOT_FOUND` (404), `VALIDATION_ERROR` (400), `DEPENDENCY_NOT_SATISFIED` (400), `CONFIG_INCOMPLETE` (400), `EXECUTION_IN_PROGRESS` (409), `UNAUTHORIZED` (401), `NAME_COLLISION` (400), `MISSING_MANIFEST` (400), `INVALID_MANIFEST` (400), `ZIP_INVALID` (400), `FILE_TOO_LARGE` (400), `MISSING_PROMPT` (400), `OPERATION_NOT_ALLOWED` (403), `FLOW_IN_USE` (409), `RATE_LIMITED` (429), `API_KEY_CONNECTION_FAILED` (500), `CONNECT_SESSION_FAILED` (500)

## Database Schema

Managed via 3 Supabase migrations (`supabase/migrations/`). All tables have Row Level Security (RLS) enabled.

```sql
-- User profiles (extends auth.users, auto-created on signup)
-- First user gets role='admin', subsequent users get role='user'
profiles (id UUID PK→auth.users, display_name, role CHECK('admin','user'), created_at, updated_at)
  -- RLS: all read, own update

-- Flow configuration (global, admin-only write)
flow_configs (flow_id PK, config JSONB, created_at, updated_at)
  -- RLS: all authenticated read, admin write

-- Execution records (per-user, state persisted per-execution)
executions (id PK, flow_id, user_id UUID, status, input JSONB, result JSONB, state JSONB, error, tokens_used, started_at, completed_at, duration, schedule_id, flow_version_id FK→flow_versions)
  -- Indexes: flow_id, status, user_id
  -- RLS: own data + admin sees all

-- Execution log entries (user_id denormalized for Realtime CDC compatibility)
execution_logs (id SERIAL PK, execution_id FK→executions ON DELETE CASCADE, user_id UUID FK→auth.users, type, event, message, data JSONB, created_at)
  -- Indexes: execution_id, (execution_id, id), user_id
  -- RLS: own data (auth.uid() = user_id) + admin sees all

-- Cron schedules (per-user)
flow_schedules (id PK, flow_id, user_id UUID, name, enabled, cron_expression, timezone, input JSONB, last_run_at, next_run_at, created_at, updated_at)
  -- Indexes: flow_id, user_id
  -- RLS: own data + admin sees all

-- User-imported flows (built-in flows are loaded from filesystem)
flows (id PK, manifest JSONB, prompt TEXT, created_at, updated_at)
  -- RLS: all authenticated read, admin write

-- Flow version snapshots (audit trail for user flow changes)
flow_versions (id SERIAL PK, flow_id, version_number, manifest JSONB, prompt TEXT, created_by UUID FK→auth.users, created_at)
  -- UNIQUE(flow_id, version_number)
  -- No FK to flows (preserves history after deletion)

-- Distributed schedule lock (prevents duplicate cron executions across instances)
schedule_runs (id PK, schedule_id FK→flow_schedules ON DELETE CASCADE, fire_time TIMESTAMPTZ, execution_id FK→executions, instance_id, created_at)
  -- UNIQUE(schedule_id, fire_time)
  -- RPC: try_acquire_schedule_lock() uses advisory lock + unique insert

-- Custom service credentials (stored in Supabase, not Nango)
custom_service_credentials (org_id UUID FK→organizations, user_id UUID FK→auth.users, flow_id TEXT, service_id TEXT, credentials JSONB, created_at, updated_at)
  -- PK: (org_id, user_id, flow_id, service_id)
  -- RLS: own data + org admin reads all
```

Supabase Realtime publishes `executions` and `execution_logs` tables.

## Flow Manifest Format

Each flow is a directory with `manifest.json` + `prompt.md` + optional `skills/`. See `flows/email-to-tickets/manifest.json` for the reference implementation. Key sections:

- **metadata**: name (kebab-case ID), displayName, description, author, tags
- **requires.services[]**: Services needed — `{id, provider, description, scopes?, schema?, authorized_uris?, connectionMode?}`. For custom services: `provider: "custom"`, `schema` defines credential fields (JSON Schema), `authorized_uris` restricts allowed URLs (applies to all service types). `connectionMode` can be `"user"` (default) or `"admin"`.
- **requires.tools[]**: Platform tools — `{id, type: "static"|"custom", description}`
- **input.schema**: Per-execution user input — `{type, description, required, default, placeholder}`
- **output.schema**: Expected result fields — `{type, description, required}`. Enables Zod validation + retry loop.
- **config.schema**: User-configurable params — `{type, default, required, enum, description}`
- **execution**: `timeout` (seconds), `maxTokens`, `outputRetries` (0-5, default 2 when output schema exists)

### Skills

Flows can include agent skills in `skills/{skill-id}/SKILL.md`. The SKILL.md file has YAML frontmatter with a `description` field. Skills are listed in the flow detail API response and their content is available inside the execution container.

## Container Protocol

The Pi runtime container streams JSON line events on stdout. The `PiAdapter` (`apps/api/src/services/adapters/pi.ts`) parses these events into `ExecutionMessage` types (progress, result, etc.).

The adapter orchestrates a **sidecar proxy pattern** for credential isolation:
1. Creates an isolated Docker network (`appstrate-exec-{execId}`)
2. Starts the sidecar container on both the default bridge (for host access) and the custom network (alias `sidecar`)
3. Starts the agent container on the custom network only — **no `EXECUTION_TOKEN`, no `PLATFORM_API_URL`, no `ExtraHosts`**
4. The agent calls `curl $SIDECAR_URL/proxy` with `X-Service` and `X-Target` headers for authenticated API requests
5. The sidecar fetches credentials, substitutes `{{variable}}` placeholders, validates URLs, and forwards the request
6. Both containers and the network are cleaned up in the `finally` block

The adapter calls `buildEnrichedPrompt(ctx)` which prepends structured sections (API access with curl proxy examples, user input with schema metadata, configuration, previous state, output format) to the raw `prompt.md`. The agent container receives `FLOW_PROMPT`, `LLM_PROVIDER`, `LLM_MODEL_ID`, `SIDECAR_URL`, `CONNECTED_SERVICES` (comma-separated service IDs, no secrets), and provider API keys. For user flows, the ZIP package from Supabase Storage is mounted into the container and extracted by the entrypoint (skills → `.pi/skills/`, extensions → loaded dynamically).

**Output validation loop**: When `output.schema` is defined in the manifest, the platform validates the extracted result with Zod (`validateOutput()`). On mismatch, it builds a retry prompt via `buildRetryPrompt()` describing the errors and expected schema, then re-executes the container. This repeats up to `execution.outputRetries` times. If validation still fails, the result is accepted as-is with a warning.

If `result.state` is present, the platform persists it to the `state` column of the execution record. The latest execution's state is injected into the next run as `## Previous State`. The agent can also fetch historical executions on demand via `$SIDECAR_URL/execution-history`.

## Environment Variables

```env
LLM_MODEL=claude-sonnet-4-5-20250929

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
PLATFORM_API_URL=http://host.docker.internal:3000  # Optional: override container-to-host URL

# Execution Adapter (pi is the default and only active adapter)
EXECUTION_ADAPTER=pi

# Pi Adapter config
LLM_PROVIDER=anthropic
LLM_MODEL_ID=claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# GEMINI_API_KEY=...
```

## Known Issues & Technical Debt

1. **Nango secret key mismatch**: The `NANGO_SECRET_KEY` in `.env` may differ from the actual key in Nango's DB (`_nango_environments` table). The `@nangohq/node` SDK handles this mapping internally, but raw `fetch()` calls to the Nango REST API need the actual DB key. Always use the SDK when possible.

2. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous `stream: false` mode that returns the full result as JSON — not yet implemented. The request body accepts `stream?: boolean` but it's ignored.

3. **Scheduler is in-memory with distributed locking**: Cron jobs run in-process via `croner`. If the server restarts, jobs are re-loaded from DB on startup. Distributed locking via `schedule_runs` table + `try_acquire_schedule_lock()` RPC prevents duplicate executions across instances.

4. **Supabase client navigator.locks bypass**: The frontend Supabase client bypasses `navigator.locks` to avoid a deadlock during session refresh. This is a workaround cast with `as any` in `apps/web/src/lib/supabase.ts`.

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
- ZIP flow import with manifest validation, skill extraction, and DB persistence
- Cron schedule CRUD with `croner` validation and distributed locking
- Output schema validation with Zod and retry loop (unit tested)
- Supabase Realtime for execution status updates and execution logs (via denormalized `user_id`)
- `GET /health` returns healthy/degraded based on DB connectivity and flow count
- Graceful shutdown: SIGTERM → stop scheduler → wait in-flight (30s) → exit
- Structured JSON logging on all API logs (no `console.*`)
- Rate limiting on execution and flow creation endpoints
- Flow versioning: create/update creates snapshot, executions tagged with `flow_version_id`
- Custom services (`provider: "custom"`) with credential schema, stored in `custom_service_credentials` table
- `authorized_uris` URL restriction on all services (custom and Nango) with pattern matching
- Sidecar proxy for credential isolation — agent cannot access `EXECUTION_TOKEN` or `/internal/credentials`
- Variable substitution (`{{variable}}`) in sidecar proxy for credentials injection
- Unified `/internal/credentials` response format for both Nango and custom services

## Detailed Specs

The full product specifications are in the Obsidian vault at:

```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
