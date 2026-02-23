# Appstrate — Developer Guide

Appstrate is an open-source platform for executing one-shot AI flows in ephemeral Docker containers. A user signs up, connects OAuth/API key services (Gmail, ClickUp), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Flows can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

## Quick Start

```sh
# 1. Start infrastructure
docker compose up -d          # PostgreSQL 16

# 2. Run database migrations
bun run db:generate           # Generate Drizzle migrations from schema
bun run db:migrate            # Apply migrations to PostgreSQL

# 3. Build runtime images
bun run build-runtime         # docker build -t appstrate-pi ./runtime-pi
bun run build-sidecar         # docker build -t appstrate-sidecar ./runtime-pi/sidecar

# 4. Configure .env (copy .env.example, set Pi adapter keys + DB URL + Better Auth secret)

# 5. Build everything (shared-types + frontend)
bun run build                 # turbo build → apps/web/dist/

# 6. Start platform (API + Vite build --watch in parallel)
bun run dev                   # turbo dev → Hono on :3010

# 7. First signup creates an organization automatically
```

## Stack & Conventions

| Layer             | Technology                                         | Notes                                                                                           |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Monorepo          | **Turborepo** + Bun workspaces                     | Single `bun install`, task caching, parallel execution                                          |
| Runtime           | **Bun**                                            | Use `bun` everywhere, not node. Bun auto-loads `.env`                                           |
| API               | **Hono**                                           | NOT `Bun.serve()` — we need Hono for SSE (`streamSSE`), routing, middleware                     |
| DB                | **PostgreSQL 16** + **Drizzle ORM**                | Schema in `packages/db/src/schema.ts`. All queries via Drizzle. No RLS — app-level security     |
| Auth              | **Better Auth** (email/password + cookie sessions) | Cookie-based sessions, auto-profile+org creation on signup via databaseHooks                    |
| OAuth/API keys    | **@appstrate/connect** (custom package)            | Manages OAuth2, API key, basic, and custom auth modes. Encrypted credential storage via Drizzle |
| Validation        | **Zod**                                            | Manifest, config, input, output validation via `services/schema.ts`                             |
| Scheduling        | **croner** (cron library)                          | In-memory cron jobs with DB persistence + distributed locking (`schedule_runs`)                 |
| ZIP import        | **fflate** (decompression)                         | User flow import from ZIP files                                                                 |
| Docker            | **Docker Engine API** via `fetch()` + unix socket  | NOT dockerode (socket bugs with Bun)                                                            |
| Container runtime | **Pi Coding Agent**                                | Uses Pi Coding Agent SDK, supports multiple LLM providers via API keys                          |
| Frontend          | **React 19 + Vite + React Query v5**               | `apps/web/`, React Router v7 BrowserRouter, builds to `apps/web/dist/`                          |
| Real-time         | **PostgreSQL LISTEN/NOTIFY + SSE**                 | Execution status + logs via pg_notify triggers → EventSource on frontend                        |
| Shared types      | **Drizzle InferSelectModel**                       | Types derived from `@appstrate/db/schema`, shared via `@appstrate/shared-types`                 |
| Storage           | **Local filesystem**                               | `STORAGE_DIR` env var (default: `./storage`). Flow packages, skills, extensions                 |

### Key Patterns

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`apps/api/src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Structured prompt injection**: `buildPromptContext()` in `env-builder.ts` assembles a typed `PromptContext` (raw prompt, tokens, config, previousState, executionApi, input, schemas). `buildEnrichedPrompt()` in `prompt-builder.ts` generates structured sections (`## User Input`, `## Configuration`, `## Previous State`, `## Execution History API`, etc.) enriched with schema metadata (types, descriptions, required), then appends the raw `prompt.md` at the end. No Handlebars — prompts are sent as-is. Only the latest execution's state is injected in the prompt (lightweight). Historical executions are available on demand via the internal API.
- **Credential isolation via sidecar proxy**: Credentials **never enter the agent container**. Each execution launches a sidecar proxy (`appstrate-sidecar`) on an isolated Docker network. The agent calls the sidecar via `curl` with `X-Service` and `X-Target` headers. The sidecar fetches credentials from `GET /internal/credentials/:serviceId`, substitutes `{{variable}}` placeholders in headers and URL, validates the URL against `authorizedUris`, and forwards the full HTTP request (any method, any body) to the target. The agent has no `EXECUTION_TOKEN`, no `PLATFORM_API_URL`, and no route to the host — only `SIDECAR_URL=http://sidecar:8080`. The sidecar also proxies execution history requests. `authorized_uris` and `allow_all_uris` are configured per provider in `provider_configs`.
- **Connection manager**: `@appstrate/connect` handles all credential operations — OAuth2 flows (PKCE), API key storage, token refresh, and encrypted credential persistence in the `service_connections` table. Provider configurations (OAuth client IDs/secrets, auth URLs, credential schemas) are stored in `provider_configs`. Built-in providers are loaded from `data/providers.json` at boot via `initBuiltInProviders()`, then merged with `SYSTEM_PROVIDERS` env var (env entries override file entries with same ID, with a warning).
- **Shared types**: Types used by both API and frontend live in `packages/shared-types/`. Derived from Drizzle schema (`@appstrate/db/schema`) via `InferSelectModel` + manual interfaces (`index.ts`). Backend re-exports them from `apps/api/src/types/index.ts`.
- **Realtime via LISTEN/NOTIFY + SSE**: Execution status changes and log inserts trigger PostgreSQL `pg_notify()` via database triggers (installed at startup by `createNotifyTriggers()`). The backend listens on dedicated channels (`execution_update`, `execution_log_insert`) via a persistent `postgres` connection. SSE endpoints (`/api/realtime/*`) stream events to the frontend using `EventSource`. The frontend uses `useExecutionRealtime`, `useExecutionLogsRealtime`, `useFlowExecutionRealtime`, and `useAllExecutionsRealtime` hooks. A global `useGlobalExecutionSync` hook patches React Query cache directly from SSE events, avoiding full refetches.
- **Output validation with retry**: When a flow defines `output.schema`, the platform validates the agent's result with Zod. On mismatch, it sends a retry prompt to the container (up to `execution.outputRetries` times, default 2).
- **FlowService (dual-read)**: Built-in flows are loaded from the `data/flows/` directory at startup into an immutable `ReadonlyMap` cache. User flows are always read from the `flows` DB table on demand. `flow-service.ts` provides `getFlow()`, `listFlows()`, `getAllFlowIds()` — no mutable singleton Map, safe for horizontal scaling.
- **Flow versioning**: Every create/update of a user flow creates a snapshot in `flow_versions` (auto-incrementing `version_number` per flow via Drizzle transaction). Executions are tagged with `flow_version_id` for audit trail. Versions are non-blocking (errors caught and logged).
- **Structured logging**: All backend logging uses `lib/logger.ts` which emits JSON to stdout (`{ level, msg, timestamp, ...data }`). No `console.*` calls.
- **Rate limiting**: Token bucket middleware per `method:path:userId`. Applied on `POST /api/flows/:id/run` (20/min), `POST /api/flows/import` (10/min), `POST /api/flows` (10/min).
- **Graceful shutdown**: `execution-tracker.ts` tracks in-flight executions. On SIGTERM/SIGINT: stop scheduler → reject new POST requests → wait in-flight (max 30s) → exit.
- **Agent skills**: Flows can include `skills/{id}/SKILL.md` files with YAML frontmatter. Skills are declared in `manifest.requires.skills[]`. Built-in skills live in `data/skills/` and are always visible in the library (`source: "built-in"`). For user flows, org skills are stored in local filesystem storage; built-in skills are resolved from the filesystem and injected into the container ZIP at runtime. Built-in skills cannot be edited or deleted via the API (403).
- **Flow extensions**: Flows can include `extensions/{id}.ts` files that define Pi agent tools (only used by the pi adapter). Built-in extensions live in `data/extensions/` and are always visible in the library (`source: "built-in"`). For user flows, org extensions are stored in local filesystem storage; built-in extensions are resolved from the filesystem. Declared in `manifest.requires.extensions[]`. Built-in extensions cannot be edited or deleted via the API (403).
- **Flow packages (ZIP)**: User flows are stored as ZIP packages on the local filesystem (`storage/flow-packages/`). Each version upload contains `manifest.json`, `prompt.md`, and optional `skills/` and `extensions/` directories. The ZIP is mounted into the container and extracted by the entrypoint.
- **Adapter system**: The platform uses an adapter pattern for execution. Currently only the `pi` adapter is active (Pi Coding Agent SDK, supports multiple LLM providers via API keys). The adapter interface is preserved in `adapters/types.ts` to allow adding future adapters. Shared prompt building logic lives in `adapters/prompt-builder.ts`.
- **Multi-tenant isolation**: Application-level security scoped by organization membership. All queries filter by `orgId`. Admins (org role `admin` or `owner`) can manage flows, configs, and providers.
- **Auth flow**: Frontend uses Better Auth React client (`createAuthClient`) → `signIn.email()` / `signUp.email()` → session cookie set automatically → sent via `credentials: "include"` on all API calls. Backend verifies session via `auth.api.getSession({ headers })`. The `X-Org-Id` header identifies the active organization.
- **Invitation system (magic links)**: Admins invite users via `POST /api/orgs/:orgId/members`. If the user exists, they're added directly. If not, an `org_invitations` record is created with a 64-char token (7-day expiry), and the API returns the token for the admin to copy the invite link. Re-inviting the same email auto-cancels prior pending invitations. The invite link (`/invite/:token`) is a public frontend route. `POST /invite/:token/accept` creates the user account (via `auth.api.signUpEmail` with a random password + `signInEmail` to get a session cookie), adds them to the org, and redirects to `/welcome` for profile setup (display name + optional password). Existing users are simply added to the org. Expired invitations are cleaned up at startup.

## Architecture

```
User Browser (BrowserRouter SPA)  Platform (Bun + Hono :3010)
     |                                |
     |-- Login/Signup --------------->|-- Better Auth (email/password → cookie session)
     |                                |-- POST /api/auth/** (Better Auth handler)
     |                                |
     |-- / (Flow List) -------------->|-- GET /api/flows (with runningExecutions count)
     |-- /flows/:id (Flow Detail) --->|-- GET /api/flows/:id (with services, config, state, skills)
     |-- PUT /api/flows/:id/config -->|-- schema.ts (Zod validation) → state.ts (Drizzle)
     |-- POST /auth/connect/:prov --->|-- connection-manager.ts → OAuth2 flow / API key storage
     |                                |
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps, config, input (Zod)
     |                                |-- 2. Create execution record (pending, user_id)
     |                                |-- 3. Fire-and-forget: executeFlowInBackground()
     |                                |-- 4. Output validation loop (if output schema)
     |<-- SSE (replay + live) --------|-- 5. Subscribe to logs via pub/sub
     |                                |
     |   Realtime (LISTEN/NOTIFY):    |-- pg_notify triggers on executions + execution_logs
     |   EventSource → SSE endpoints  |-- useExecutionRealtime() + useExecutionLogsRealtime()
     |   + useGlobalExecutionSync()   |-- Patches React Query cache directly (no refetch)
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
     |-- /flows/:id/executions/:eid-->|
     |   (Execution Detail)           |
     |-- GET /api/executions/:id/stream (SSE: replay DB + live via pub/sub)
     |-- GET /api/executions/:id/logs  (REST: paginated historical logs)
     |                                |
     |-- POST /api/flows/import ------>|-- flow-import.ts: unzip, validate manifest, persist to DB
     |-- DELETE /api/flows/:id ------->|-- user-flows.ts: delete user flow + cascade cleanup
     |                                |
     |-- /schedules (Schedules List)->|-- GET /api/schedules, CRUD per flow
     |-- /org-settings (Org Settings)->|-- Provider CRUD, member management, invitations
     |                                |
     |   Invitations (magic links):   |-- POST /api/orgs/:orgId/members → invite if user not found
     |   /invite/:token (public)      |-- GET /invite/:token/info → invitation metadata
     |                                |-- POST /invite/:token/accept → create user or add to org
     |   /welcome (post-signup)       |-- POST /api/welcome/setup → set displayName + password
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
├── docker-compose.yml                # PostgreSQL 16
├── CLAUDE.md
│
├── data/                              # Static data directory (centralized)
│   ├── flows/                         # Built-in flow definitions (loaded at runtime)
│   │   └── {flow-name}/
│   │       ├── manifest.json          # Flow spec: metadata, requires, config/state/input/output schema
│   │       └── prompt.md              # Agent instructions
│   ├── providers.json                 # Built-in provider definitions (merged with SYSTEM_PROVIDERS env var)
│   ├── skills/                        # Built-in skills (always visible in library, source: "built-in")
│   │   └── {skill-id}/
│   │       └── SKILL.md               # Skill definition with YAML frontmatter
│   ├── extensions/                    # Built-in extensions (always visible in library, source: "built-in")
│   │   └── {extension-id}.ts          # Extension file (Pi agent tool)
│   └── storage/                       # Local file storage (flow packages, execution files)
│
├── apps/
│   ├── api/                          # @appstrate/api — Backend (Hono + Bun)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── eslint.config.js
│   │   └── src/
│   │       ├── index.ts              # Hono app entry: CORS, Better Auth handler, cookie auth middleware, health route, shutdown gate, graceful shutdown, scheduler init, NOTIFY triggers, built-in providers/library init
│   │       ├── lib/
│   │       │   ├── db.ts             # Re-exports db, Db, listenClient from @appstrate/db/client
│   │       │   ├── auth.ts           # Re-exports auth from @appstrate/db/auth + getUserProfile(), isAdmin()
│   │       │   └── logger.ts         # Structured JSON logger (debug, info, warn, error → stdout)
│   │       ├── middleware/
│   │       │   └── rate-limit.ts     # Token bucket rate limiter per userId (in-memory, auto-cleanup)
│   │       ├── routes/
│   │       │   ├── flows.ts          # GET /api/flows, GET /api/flows/:id, GET /api/flows/:id/versions, PUT /api/flows/:id/config
│   │       │   ├── executions.ts     # POST /api/flows/:id/run (rate-limited), GET /api/executions/:id, executeFlowInBackground()
│   │       │   ├── schedules.ts      # CRUD for /api/schedules and /api/flows/:id/schedules
│   │       │   ├── user-flows.ts     # POST /api/flows/import (rate-limited), POST/PUT/DELETE /api/flows/:id (admin, user flows only)
│   │       │   ├── health.ts         # GET /health (no auth) — DB + flows checks → healthy/degraded
│   │       │   ├── auth.ts           # Auth routes: OAuth callback, connect, disconnect, connections, integrations
│   │       │   ├── providers.ts      # Provider CRUD: GET/POST/PUT/DELETE /api/providers
│   │       │   ├── share.ts          # Public share token routes: POST /share/:token/run, GET /share/:token/status
│   │       │   ├── internal.ts       # GET /internal/execution-history, GET /internal/credentials/:serviceId (container-to-host, auth via execution token)
│   │       │   ├── organizations.ts  # Organization management routes
│   │       │   ├── profile.ts        # User profile routes
│   │       │   ├── library.ts        # Org library routes (skills + extensions)
│   │       │   ├── realtime.ts       # SSE endpoints: /api/realtime/executions, /api/realtime/executions/:id, /api/realtime/flows/:id/executions
│   │       │   ├── invitations.ts   # Public: GET /invite/:token/info, POST /invite/:token/accept (magic link acceptance)
│   │       │   ├── welcome.ts       # POST /api/welcome/setup (profile setup after invite signup)
│   │       │   └── __tests__/
│   │       │       └── execution-retry.test.ts  # Output validation retry tests
│   │       ├── services/
│   │       │   ├── docker.ts         # dockerFetch(), createContainer, streamLogs, network ops (createNetwork, connectToNetwork, removeNetwork)
│   │       │   ├── realtime.ts       # PostgreSQL LISTEN/NOTIFY service: subscribe/unsubscribe, event dispatch, trigger installation
│   │       │   ├── adapters/
│   │       │   │   ├── types.ts      # ExecutionAdapter interface, ExecutionMessage type, PromptContext, TimeoutError
│   │       │   │   ├── index.ts      # getAdapter() factory, re-exports
│   │       │   │   ├── prompt-builder.ts # Shared: buildEnrichedPrompt, extractJsonResult, buildRetryPrompt
│   │       │   │   ├── container-lifecycle.ts # Container create/start/cleanup helpers
│   │       │   │   └── pi.ts         # PiAdapter: sidecar orchestration (network + sidecar + agent), stream parsing
│   │       │   ├── connection-manager.ts # Service wrapper over @appstrate/connect (OAuth, connections, status resolution)
│   │       │   ├── dependency-validation.ts # Validate flow service dependencies before execution
│   │       │   ├── token-resolver.ts # Resolve service tokens for execution (admin vs user connections)
│   │       │   ├── input-parser.ts   # Parse and validate execution input from request body
│   │       │   ├── state.ts          # Drizzle CRUD for flow_configs, executions (with state), execution_logs tables
│   │       │   ├── flow-service.ts   # FlowService: built-in cache (ReadonlyMap) + DB reads for user flows
│   │       │   ├── flow-versions.ts  # Flow versioning: createFlowVersion(), listFlowVersions(), getLatestVersionId(), createVersionAndUpload()
│   │       │   ├── flow-import.ts    # importFlowFromZip(): unzip, validate manifest, extract skills, persist
│   │       │   ├── flow-package.ts   # Get flow package ZIP from local filesystem storage for container injection
│   │       │   ├── file-storage.ts   # Upload/cleanup execution files on local filesystem
│   │       │   ├── user-flows.ts     # DB CRUD for user flows table (get, insert, update, delete with cascade)
│   │       │   ├── share-tokens.ts   # Share token CRUD (create, consume, get, link)
│   │       │   ├── execution-tracker.ts # In-flight execution tracking for graceful shutdown (track/untrack/waitForInFlight)
│   │       │   ├── scheduler.ts      # Cron job lifecycle with distributed locking (schedule_runs table)
│   │       │   ├── schema.ts         # Zod validation: validateManifest, validateConfig, validateInput, validateOutput
│   │       │   ├── env-builder.ts    # buildPromptContext(), resolveProviderDefs(), buildExecutionContext(): builds typed PromptContext and full execution context
│   │       │   ├── library.ts        # Org library CRUD for skills and extensions
│   │       │   ├── organizations.ts  # Organization CRUD and membership management
│   │       │   ├── builtin-library.ts # Built-in skills/extensions from data/ directory (loaded at boot)
│   │       │   ├── skill-utils.ts    # Skill file parsing utilities
│   │       │   └── invitations.ts    # Invitation CRUD: create, accept, cancel, expire
│   │       └── types/
│   │           └── index.ts          # Backend-only types (FlowManifest, LoadedFlow, SkillMeta) + re-exports from @appstrate/shared-types
│   │
│   └── web/                          # @appstrate/web — Frontend (React + Vite)
│       ├── package.json
│       ├── tsconfig.json
│       ├── eslint.config.js
│       ├── vite.config.ts            # envDir: "../../" to load env vars from monorepo root
│       ├── index.html
│       └── src/
│           ├── main.tsx              # Root: QueryClientProvider + BrowserRouter + App
│           ├── app.tsx               # Auth gate (LoginPage if !user), layout with UserMenu, nav, <Routes/>, useGlobalExecutionSync
│           ├── styles.css            # All CSS (dark theme)
│           ├── api.ts                # apiFetch(), api() — cookie-based auth via credentials: "include", X-Org-Id header
│           ├── lib/
│           │   ├── auth-client.ts    # Better Auth React client: createAuthClient({ baseURL: "/" })
│           │   └── markdown.ts       # escapeHtml, convertMarkdown, truncate, formatDateField
│           ├── hooks/
│           │   ├── use-auth.ts       # useAuth(): login, signup, logout, user, profile, isAdmin (Better Auth useSession)
│           │   ├── use-flows.ts      # useFlows(), useFlowDetail(flowId)
│           │   ├── use-executions.ts # useExecutions, useExecution, useExecutionLogs
│           │   ├── use-services.ts   # useServices()
│           │   ├── use-providers.ts  # useProviders(), useCreateProvider, useUpdateProvider, useDeleteProvider
│           │   ├── use-schedules.ts  # useSchedules(flowId), useAllSchedules()
│           │   ├── use-mutations.ts  # useSaveConfig, useResetState, useRunFlow, useConnect, useDisconnect, schedule mutations
│           │   ├── use-org.ts        # useOrg(), org context
│           │   ├── use-profile.ts    # useProfile(), profile management
│           │   ├── use-library.ts    # useLibrary(), skills and extensions CRUD
│           │   ├── use-realtime.ts   # SSE EventSource hooks: useExecutionRealtime, useExecutionLogsRealtime, useFlowExecutionRealtime, useAllExecutionsRealtime
│           │   └── use-global-execution-sync.ts # Global SSE → React Query cache sync (patches execution data, invalidates flow counts)
│           ├── pages/
│           │   ├── login.tsx         # Login/signup form (email + password + display name)
│           │   ├── create-org.tsx    # Organization creation page
│           │   ├── flow-list.tsx     # / — flow cards grid with import button
│           │   ├── flow-detail.tsx   # /flows/:flowId — config/state/input modals, execution list, service connect
│           │   ├── flow-editor.tsx   # /flows/:flowId/edit — flow manifest editor
│           │   ├── execution-detail.tsx # /flows/:flowId/executions/:execId — logs + result via SSE
│           │   ├── invite-accept.tsx # /invite/:token — public invitation acceptance page
│           │   ├── welcome.tsx      # /welcome — post-invite profile setup (displayName + password)
│           │   ├── org-settings.tsx  # /org-settings — provider CRUD, member management, invitations
│           │   ├── library.tsx       # /library — org skills and extensions management
│           │   ├── preferences.tsx   # /preferences — user preferences (language)
│           │   ├── schedules-list.tsx # /schedules — manage cron schedules across all flows
│           │   ├── public-share-run.tsx # Public share execution page
│           │   └── shareable-run.tsx # Shareable run page
│           └── components/
│               ├── modal.tsx         # Generic overlay + escape + click-outside
│               ├── config-modal.tsx  # Config form, useSaveConfig mutation
│               ├── input-modal.tsx   # Input form before run
│               ├── import-modal.tsx  # ZIP file upload for flow import
│               ├── api-key-modal.tsx # API key input for non-OAuth integrations
│               ├── custom-credentials-modal.tsx # Dynamic credential form for custom services (based on schema)
│               ├── provider-form-modal.tsx # Provider configuration form (OAuth2, API key, etc.)
│               ├── schedule-modal.tsx # Create/edit cron schedule form
│               ├── schedule-row.tsx  # Schedule row with enable/disable/delete
│               ├── share-dropdown.tsx # Share link management dropdown
│               ├── form-field.tsx    # Reusable labeled form field component
│               ├── file-field.tsx    # File upload field component
│               ├── input-fields.tsx  # Dynamic input field rendering
│               ├── log-viewer.tsx    # Log entries with type-based styling + auto-scroll
│               ├── result-renderer.tsx # Full result render pipeline
│               ├── library-item-detail.tsx # Library item detail view
│               ├── org-switcher.tsx  # Organization switching component
│               ├── page-states.tsx   # Loading/empty/error page state components
│               ├── error-boundary.tsx # React error boundary wrapper
│               ├── badge.tsx         # Status badge with conditional spinner
│               ├── spinner.tsx       # <span className="spinner" />
│               └── flow-editor/     # Flow editor components (service picker, schema editor, etc.)
│
├── packages/
│   ├── db/                           # @appstrate/db — Database layer (Drizzle + Better Auth)
│   │   ├── package.json              # Exports: ./schema, ./client, ./auth, ./storage, ./notify
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts         # Drizzle Kit config (PostgreSQL, schema path, migrations dir)
│   │   ├── drizzle/                  # Generated migration files (drizzle-kit generate)
│   │   └── src/
│   │       ├── schema.ts             # Full Drizzle schema: 24 tables, enums, indexes, types
│   │       ├── client.ts             # db instance (drizzle + postgres), listenClient (LISTEN), createDb(), closeDb()
│   │       ├── auth.ts               # Better Auth config: email/password, cookie sessions, databaseHooks (auto profile+org)
│   │       ├── storage.ts            # Local filesystem storage: uploadFile, downloadFile, deleteFile, listFiles
│   │       ├── notify.ts             # createNotifyTriggers(): installs pg_notify triggers on executions + execution_logs
│   │       └── index.ts              # Barrel exports
│   │
│   ├── shared-types/                 # @appstrate/shared-types — Types used by both apps
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       └── index.ts              # Re-exports Drizzle InferSelectModel types from @appstrate/db/schema + manual interfaces (FlowDetail, Integration, etc.)
│   │
│   └── connect/                      # @appstrate/connect — Connection manager package
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts              # Main exports: getProvider, listProviders, connection operations
│           ├── credentials.ts        # Credential resolution for execution (admin vs user connections)
│           ├── encryption.ts         # AES-256-GCM encryption for OAuth secrets and credentials
│           ├── oauth.ts              # OAuth2 flow helpers (authorization URL, token exchange, PKCE)
│           ├── registry.ts           # System provider registry (loaded from SYSTEM_PROVIDERS env var)
│           ├── scopes.ts             # OAuth scope management
│           ├── token-refresh.ts      # Automatic OAuth2 token refresh
│           ├── token-utils.ts        # Token utility functions
│           ├── types.ts              # Package types (ProviderConfig, ServiceConnection, etc.)
│           └── utils.ts              # Shared utility functions
│
└── runtime-pi/                       # Docker image for Pi Coding Agent SDK
    ├── Dockerfile
    ├── package.json
    ├── entrypoint.ts                 # SDK session → JSON line stdout
    ├── extensions/                   # Built-in extensions shipped with image
    │   ├── web-fetch.ts              # Fetch URL content
    │   └── web-search.ts             # DuckDuckGo web search
    └── sidecar/                      # Credential-isolating sidecar proxy
        ├── Dockerfile                # oven/bun:1-slim + hono
        ├── package.json
        └── server.ts                 # Transparent HTTP proxy: credential injection, URL validation, body streaming
```

## API Endpoints

### Auth (Better Auth)

| Method | Path                      | Auth   | Description                                                  |
| ------ | ------------------------- | ------ | ------------------------------------------------------------ |
| `POST` | `/api/auth/sign-up/email` | None   | Create account (email, password, name) → sets session cookie |
| `POST` | `/api/auth/sign-in/email` | None   | Login → sets session cookie                                  |
| `POST` | `/api/auth/sign-out`      | Cookie | Logout → clears session cookie                               |
| `GET`  | `/api/auth/get-session`   | Cookie | Get current session + user info                              |

### Flows

| Method   | Path                      | Auth         | Description                                                                 |
| -------- | ------------------------- | ------------ | --------------------------------------------------------------------------- |
| `GET`    | `/api/flows`              | Cookie       | List all flows (built-in + user) with `runningExecutions` count             |
| `GET`    | `/api/flows/:id`          | Cookie       | Flow detail with service statuses (incl. `authMode`), config, state, skills |
| `PUT`    | `/api/flows/:id/config`   | Cookie+Admin | Save flow configuration (Zod-validated against manifest schema)             |
| `POST`   | `/api/flows/import`       | Cookie+Admin | Import flow from ZIP file (multipart/form-data)                             |
| `GET`    | `/api/flows/:id/versions` | Cookie       | List version history for a user flow (newest first)                         |
| `DELETE` | `/api/flows/:id`          | Cookie+Admin | Delete a user-imported flow (built-in flows cannot be deleted)              |

### Executions

| Method | Path                         | Auth   | Description                                                                 |
| ------ | ---------------------------- | ------ | --------------------------------------------------------------------------- |
| `POST` | `/api/flows/:id/run`         | Cookie | Execute flow (fire-and-forget) — returns `{ executionId }`                  |
| `GET`  | `/api/flows/:id/executions`  | Cookie | List executions for a flow (default limit 50, org-scoped)                   |
| `GET`  | `/api/executions/:id`        | Cookie | Get execution status/result                                                 |
| `GET`  | `/api/executions/:id/logs`   | Cookie | Get persisted logs (pagination via `?after=lastId`)                         |
| `GET`  | `/api/executions/:id/stream` | Cookie | SSE stream: replays all logs from DB, then streams live updates via pub/sub |
| `POST` | `/api/executions/:id/cancel` | Cookie | Cancel a running/pending execution                                          |

### Realtime (SSE)

| Method | Path                                     | Auth   | Description                                              |
| ------ | ---------------------------------------- | ------ | -------------------------------------------------------- |
| `GET`  | `/api/realtime/executions`               | Cookie | SSE: all execution status changes (for flow list counts) |
| `GET`  | `/api/realtime/executions/:id`           | Cookie | SSE: execution status + log events for one execution     |
| `GET`  | `/api/realtime/flows/:flowId/executions` | Cookie | SSE: execution changes for a specific flow               |

### Schedules

| Method   | Path                       | Auth   | Description                                        |
| -------- | -------------------------- | ------ | -------------------------------------------------- |
| `GET`    | `/api/schedules`           | Cookie | List all schedules across all flows (org-scoped)   |
| `GET`    | `/api/flows/:id/schedules` | Cookie | List schedules for a specific flow                 |
| `POST`   | `/api/flows/:id/schedules` | Cookie | Create a cron schedule for a flow                  |
| `GET`    | `/api/schedules/:id`       | Cookie | Get a single schedule                              |
| `PUT`    | `/api/schedules/:id`       | Cookie | Update a schedule (cron, timezone, enabled, input) |
| `DELETE` | `/api/schedules/:id`       | Cookie | Delete a schedule                                  |

### Auth / Connections

| Method   | Path                          | Auth   | Description                                                    |
| -------- | ----------------------------- | ------ | -------------------------------------------------------------- |
| `GET`    | `/auth/connections`           | Cookie | List active service connections (org + user scoped)            |
| `GET`    | `/auth/integrations`          | Cookie | List all providers with connection status and `authMode`       |
| `POST`   | `/auth/connect/:provider`     | Cookie | Start OAuth2 flow (returns `authorizationUrl`) or save API key |
| `GET`    | `/auth/callback`              | None   | OAuth2 callback handler (exchanges code for tokens)            |
| `DELETE` | `/auth/connections/:provider` | Cookie | Disconnect a service                                           |

### Providers

| Method   | Path                 | Auth         | Description                                      |
| -------- | -------------------- | ------------ | ------------------------------------------------ |
| `GET`    | `/api/providers`     | Cookie       | List all provider configs for the org            |
| `POST`   | `/api/providers`     | Cookie+Admin | Create a provider config (OAuth2, API key, etc.) |
| `PUT`    | `/api/providers/:id` | Cookie+Admin | Update a provider config                         |
| `DELETE` | `/api/providers/:id` | Cookie+Admin | Delete a provider config                         |

### Invitations (Magic Links)

| Method   | Path                                         | Auth         | Description                                                                |
| -------- | -------------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| `GET`    | `/invite/:token/info`                        | None         | Invitation metadata (email, orgName, role, inviterName, expiresAt)         |
| `POST`   | `/invite/:token/accept`                      | None         | Accept invitation — auto-signup (new) or add to org (existing), set cookie |
| `DELETE` | `/api/orgs/:orgId/invitations/:invitationId` | Cookie+Admin | Cancel a pending invitation                                                |

### Welcome (Post-Invite Setup)

| Method | Path                 | Auth   | Description                                              |
| ------ | -------------------- | ------ | -------------------------------------------------------- |
| `POST` | `/api/welcome/setup` | Cookie | Set display name and/or password after invitation signup |

### Internal (container-to-host)

| Method | Path                               | Auth          | Description                                                                 |
| ------ | ---------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `GET`  | `/internal/execution-history`      | Bearer execId | Fetch historical executions for the current flow (fields: state, result)    |
| `GET`  | `/internal/credentials/:serviceId` | Bearer execId | Fetch credentials for a service — returns `{ credentials, authorizedUris }` |

### Other

| Method | Path      | Auth | Description                                                           |
| ------ | --------- | ---- | --------------------------------------------------------------------- |
| `GET`  | `/health` | None | Health check — `{ status: "healthy"\|"degraded", uptime_ms, checks }` |
| `GET`  | `/*`      | None | Static files from `apps/web/dist/`                                    |

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

`FLOW_NOT_FOUND` (404), `VALIDATION_ERROR` (400), `DEPENDENCY_NOT_SATISFIED` (400), `CONFIG_INCOMPLETE` (400), `EXECUTION_IN_PROGRESS` (409), `UNAUTHORIZED` (401), `NAME_COLLISION` (400), `MISSING_MANIFEST` (400), `INVALID_MANIFEST` (400), `ZIP_INVALID` (400), `FILE_TOO_LARGE` (400), `MISSING_PROMPT` (400), `OPERATION_NOT_ALLOWED` (403), `FLOW_IN_USE` (409), `RATE_LIMITED` (429)

## Database Schema

Managed via Drizzle ORM. Schema defined in `packages/db/src/schema.ts`. Migrations generated with `drizzle-kit generate` and applied with `drizzle-kit migrate`. No RLS — application-level security scopes all queries by `orgId`.

```
-- Better Auth tables (managed by Better Auth, defined in schema for Drizzle awareness)
user (id TEXT PK, name, email UNIQUE, email_verified, image, created_at, updated_at)
session (id TEXT PK, expires_at, token UNIQUE, user_id FK→user CASCADE, ip_address, user_agent, created_at, updated_at)
account (id TEXT PK, account_id, provider_id, user_id FK→user CASCADE, access_token, refresh_token, password, ...)
verification (id TEXT PK, identifier, value, expires_at, created_at, updated_at)

-- Organizations and membership
organizations (id UUID PK, name, slug UNIQUE, created_by TEXT FK→user, created_at, updated_at)
organization_members (org_id UUID FK→organizations CASCADE, user_id TEXT FK→user CASCADE, role ENUM('owner','admin','member'), joined_at, PK(org_id, user_id))

-- User profiles (extends user, auto-created on signup via databaseHooks)
profiles (id TEXT PK FK→user CASCADE, display_name, language CHECK('fr','en'), created_at, updated_at)

-- Flow configuration (org-scoped)
flow_configs (org_id UUID FK→organizations, flow_id TEXT, config JSONB, created_at, updated_at, PK(org_id, flow_id))

-- User-imported flows (built-in flows loaded from filesystem)
flows (id TEXT PK, org_id UUID FK→organizations, manifest JSONB, prompt TEXT, created_at, updated_at)
  -- CHECK: id matches kebab-case slug pattern

-- Flow version snapshots (audit trail)
flow_versions (id SERIAL PK, flow_id TEXT, version_number INT, created_by TEXT FK→user, created_at)
  -- UNIQUE(flow_id, version_number)

-- Execution records (org-scoped, per-user)
executions (id TEXT PK, flow_id, user_id TEXT FK→user, org_id UUID FK→organizations, status ENUM('pending','running','success','failed','timeout','cancelled'), input JSONB, result JSONB, state JSONB, error, tokens_used, token_usage JSONB, cost_usd NUMERIC, started_at, completed_at, duration, schedule_id, flow_version_id FK→flow_versions)
  -- Indexes: flow_id, status, user_id, org_id
  -- NOTIFY trigger: pg_notify('execution_update', JSON payload) on INSERT/UPDATE

-- Execution log entries (user_id + org_id denormalized for org-scoping)
execution_logs (id SERIAL PK, execution_id FK→executions CASCADE, user_id TEXT FK→user, org_id UUID FK→organizations, type, event, message, data JSONB, created_at)
  -- Indexes: execution_id, (execution_id, id), user_id, org_id
  -- NOTIFY trigger: pg_notify('execution_log_insert', JSON payload) on INSERT

-- Cron schedules (org-scoped, per-user)
flow_schedules (id TEXT PK, flow_id, user_id TEXT FK→user, org_id UUID FK→organizations, name, enabled, cron_expression, timezone, input JSONB, last_run_at, next_run_at, created_at, updated_at)

-- Schedule run deduplication
schedule_runs (id TEXT PK, schedule_id FK→flow_schedules CASCADE, fire_time, execution_id FK→executions, instance_id, created_at)
  -- UNIQUE(schedule_id, fire_time)

-- Share tokens (one-time public execution links)
share_tokens (id TEXT PK, token UNIQUE, flow_id, org_id UUID FK→organizations, created_by TEXT FK→user, execution_id FK→executions, consumed_at, expires_at, created_at)

-- Flow admin connections
flow_admin_connections (flow_id, service_id, org_id UUID FK→organizations, admin_user_id TEXT FK→user, connected_at, PK(flow_id, service_id))

-- Organization invitations (magic link system)
org_invitations (id TEXT PK, token TEXT UNIQUE, email TEXT, org_id UUID FK→organizations CASCADE, role ENUM('owner','admin','member'), status ENUM('pending','accepted','expired','cancelled'), invited_by TEXT FK→user, accepted_by TEXT FK→user, expires_at TIMESTAMP, accepted_at TIMESTAMP, created_at)
  -- Indexes: token, org_id, email
  -- 7-day expiry, auto-cancel on re-invite, cleaned at startup via expireOldInvitations()

-- Organization library
org_skills (id TEXT, org_id UUID FK→organizations CASCADE, name, description, content TEXT, created_by TEXT FK→user, created_at, updated_at, PK(org_id, id))
org_extensions (id TEXT, org_id UUID FK→organizations CASCADE, name, description, content TEXT, created_by TEXT FK→user, created_at, updated_at, PK(org_id, id))
flow_skills (flow_id FK→flows CASCADE, skill_id, org_id UUID, created_at, PK(flow_id, skill_id))
flow_extensions (flow_id FK→flows CASCADE, extension_id, org_id UUID, created_at, PK(flow_id, extension_id))

-- Provider configurations (connection manager)
provider_configs (id TEXT, org_id UUID FK→organizations CASCADE, auth_mode ENUM('oauth2','api_key','basic','custom'), display_name, client_id_encrypted, client_secret_encrypted, authorization_url, token_url, refresh_url, default_scopes TEXT[], scope_separator, pkce_enabled, authorization_params JSONB, token_params JSONB, credential_schema JSONB, credential_field_name, credential_header_name, credential_header_prefix, available_scopes JSONB, authorized_uris TEXT[], allow_all_uris BOOLEAN, icon_url, categories TEXT[], docs_url, created_at, updated_at, PK(org_id, id))

-- Unified service connections (encrypted credential storage)
service_connections (id UUID PK, org_id UUID FK→organizations CASCADE, user_id TEXT FK→user CASCADE, provider_id, flow_id, auth_mode ENUM, credentials_encrypted, scopes_granted TEXT[], expires_at, raw_token_response JSONB, connection_config JSONB, metadata JSONB, created_at, updated_at)
  -- Unique: (org_id, user_id, provider_id, COALESCE(flow_id, '__global__'))

-- OAuth state tracking (short-lived, 10 min expiry)
oauth_states (state TEXT PK, org_id UUID, user_id TEXT FK→user CASCADE, provider_id, code_verifier, scopes_requested TEXT[], redirect_uri, created_at, expires_at)
```

## Flow Manifest Format

Each flow is a directory with `manifest.json` + `prompt.md` + optional `skills/`. See `flows/pdf-explainer/manifest.json` for the reference implementation. Key sections:

- **schemaVersion**: Format version string (e.g. `"1.0.0"`)
- **metadata**: id (kebab-case slug), displayName, description (required), author, tags
- **requires.services[]**: Services needed — `{id, provider, scopes?, connectionMode?}`. `connectionMode` can be `"user"` (default) or `"admin"`.
- **requires.skills[]**: Skill IDs as `string[]` (e.g. `["greeting-style"]`)
- **requires.extensions[]**: Extension IDs as `string[]` (e.g. `["web-search"]`)
- **input.schema**: Per-execution user input — `{type, description, required, default, placeholder}`
- **output.schema**: Expected result fields — `{type, description, required}`. Enables Zod validation + retry loop.
- **config.schema**: User-configurable params — `{type, default, required, enum, description}`
- **execution**: `timeout` (seconds), `outputRetries` (0-5, default 2 when output schema exists)

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

The adapter calls `buildEnrichedPrompt(ctx)` which prepends structured sections (API access with curl proxy examples, user input with schema metadata, configuration, previous state, output format) to the raw `prompt.md`. The agent container receives `FLOW_PROMPT`, `LLM_PROVIDER`, `LLM_MODEL_ID`, `SIDECAR_URL`, `CONNECTED_SERVICES` (comma-separated service IDs, no secrets), and provider API keys. For user flows, the ZIP package from local storage is mounted into the container and extracted by the entrypoint (skills → `.pi/skills/`, extensions → loaded dynamically).

**Output validation loop**: When `output.schema` is defined in the manifest, the platform validates the extracted result with Zod (`validateOutput()`). On mismatch, it builds a retry prompt via `buildRetryPrompt()` describing the errors and expected schema, then re-executes the container. This repeats up to `execution.outputRetries` times. If validation still fails, the result is accepted as-is with a warning.

If `result.state` is present, the platform persists it to the `state` column of the execution record. The latest execution's state is injected into the next run as `## Previous State`. The agent can also fetch historical executions on demand via `$SIDECAR_URL/execution-history`.

## Environment Variables

```env
# Database (PostgreSQL + Drizzle)
DATABASE_URL=postgresql://appstrate:appstrate@localhost:5432/appstrate

# App
APP_URL=http://localhost:3010              # Base URL for the platform (auth, invitation links, etc.)

# Better Auth
BETTER_AUTH_SECRET=<random-secret>          # Session signing secret (use a strong random value in production)
# TRUSTED_ORIGINS=http://localhost:3000,http://localhost:5173  # Optional: comma-separated trusted origins (CORS + Better Auth)

# Connection Manager
CONNECTION_ENCRYPTION_KEY=<base64-256bit>   # openssl rand -base64 32 (AES-256-GCM for credential encryption)
OAUTH_CALLBACK_URL=http://localhost:3010/auth/callback  # OAuth2 redirect URI
SYSTEM_PROVIDERS='[]'                       # JSON array of system provider configs to bootstrap

# Platform
PORT=3010
DOCKER_SOCKET=/var/run/docker.sock
PLATFORM_API_URL=http://host.docker.internal:3010  # Optional: override container-to-host URL
STORAGE_DIR=./storage                  # Local filesystem storage directory

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

1. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous `stream: false` mode that returns the full result as JSON — not yet implemented. The request body accepts `stream?: boolean` but it's ignored.

2. **Scheduler is in-memory with distributed locking**: Cron jobs run in-process via `croner`. If the server restarts, jobs are re-loaded from DB on startup. Distributed locking via `schedule_runs` table prevents duplicate executions across instances.

## What's Validated

- `turbo build` builds shared-types + connect + db + frontend successfully
- `turbo check` passes for all 5 packages (tsc + eslint + prettier)
- `turbo dev` runs API + Vite build --watch in parallel
- `GET /api/flows` returns flows with correct structure (built-in + user sources)
- Better Auth cookie-based auth middleware blocks unauthenticated requests to `/api/*` and `/auth/*`
- Multi-tenant isolation via org-scoped queries (users see own org data)
- Organization creation on first signup with owner role (via Better Auth databaseHooks)
- Login/signup flow with email + password (cookie-based sessions)
- Static file serving works for `apps/web/dist/`
- OAuth2 flow with PKCE via `@appstrate/connect` (Gmail, ClickUp, Google Calendar)
- API key connection flow (Brevo, etc.) — `authMode` detection from provider config
- Service connections scoped per org + user
- Provider CRUD (create, update, delete) with encrypted credential storage
- System provider bootstrapping via `SYSTEM_PROVIDERS` env var
- ZIP flow import with manifest validation, skill extraction, and DB persistence
- Cron schedule CRUD with `croner` validation and distributed locking
- Output schema validation with Zod and retry loop (unit tested)
- PostgreSQL LISTEN/NOTIFY + SSE for real-time execution status updates and logs
- `GET /health` returns healthy/degraded based on DB connectivity and flow count
- Graceful shutdown: SIGTERM → stop scheduler → wait in-flight (30s) → exit
- Structured JSON logging on all API logs (no `console.*`)
- Rate limiting on execution and flow creation endpoints
- Flow versioning: create/update creates snapshot, executions tagged with `flow_version_id`
- `authorized_uris` / `allow_all_uris` URL restriction on all providers with pattern matching
- Sidecar proxy for credential isolation — agent cannot access `EXECUTION_TOKEN` or `/internal/credentials`
- Variable substitution (`{{variable}}`) in sidecar proxy for credentials injection
- Drizzle migrations generated and applied (24 tables)
- NOTIFY triggers installed at startup for executions + execution_logs
- Invitation magic links: create invitation, copy invite link, accept (new user auto-signup + existing user org join), expire/cancel
- Public `/invite/:token/info` and `/invite/:token/accept` endpoints (no auth required)
- Welcome page `/api/welcome/setup` for post-invite profile setup (displayName + password)
- Expired invitations cleanup at startup via `expireOldInvitations()`

## Detailed Specs

The full product specifications are in the Obsidian vault at:

```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
