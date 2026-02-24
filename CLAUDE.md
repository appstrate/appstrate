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

#### Execution & Containers

- **Docker Engine API**: All Docker operations use `fetch()` with Bun's `unix:` socket option (`apps/api/src/services/docker.ts`). The `@ts-expect-error` on the unix option is intentional.
- **Multiplexed streams**: Docker log streams use 8-byte frame headers `[stream_type(1), 0(3), size(4)]`. Parsed in `streamLogs()`.
- **SSE streaming**: Execution results stream via Hono's `streamSSE()`. The container outputs JSON lines on stdout, the platform parses and re-emits as SSE events.
- **Adapter system**: Currently only the `pi` adapter is active (Pi Coding Agent SDK). Interface in `adapters/types.ts`, shared prompt logic in `adapters/prompt-builder.ts`.
- **Sidecar proxy, prompt injection, output validation**: See the Container Protocol section for full details on credential isolation, `buildEnrichedPrompt()`, and Zod retry loop.

#### Auth & Security

- **Auth flow**: Frontend uses Better Auth React client (`createAuthClient`) → `signIn.email()` / `signUp.email()` → session cookie set automatically → sent via `credentials: "include"` on all API calls. Backend verifies session via `auth.api.getSession({ headers })`. The `X-Org-Id` header identifies the active organization. API key auth is tried first (Bearer header), then falls back to cookie session.
- **API key authentication**: API keys (`ask_` prefix + 48 hex chars) authenticate via `Authorization: Bearer ask_...`. The key is SHA-256 hashed and looked up in the `api_keys` table. Org is resolved from the key (no `X-Org-Id` needed). Keys can have an expiration date or be permanent (`expires_at = NULL`). Expired/revoked keys are rejected. `lastUsedAt` is updated fire-and-forget on each use. Expired keys are auto-revoked at startup.
- **Multi-tenant isolation**: Application-level security scoped by organization membership. All queries filter by `orgId`. Admins (org role `admin` or `owner`) can manage flows, configs, and providers.
- **Connection manager**: `@appstrate/connect` handles all credential operations — OAuth2 flows (PKCE), API key storage, token refresh, and encrypted credential persistence in the `service_connections` table. Provider configurations (OAuth client IDs/secrets, auth URLs, credential schemas) are stored in `provider_configs`. Built-in providers are loaded from `data/providers.json` at boot via `initBuiltInProviders()`, then merged with `SYSTEM_PROVIDERS` env var (env entries override file entries with same ID, with a warning).
- **Invitation system (magic links)**: Admins invite users via `POST /api/orgs/:orgId/members`. If the user exists, they're added directly. If not, an `org_invitations` record is created with a 64-char token (7-day expiry), and the API returns the token for the admin to copy the invite link. Re-inviting the same email auto-cancels prior pending invitations. The invite link (`/invite/:token`) is a public frontend route. `POST /invite/:token/accept` creates the user account (via `auth.api.signUpEmail` with a random password + `signInEmail` to get a session cookie), adds them to the org, and redirects to `/welcome` for profile setup (display name + optional password). Existing users are simply added to the org. Expired invitations are cleaned up at startup.

#### Flows & Library

- **FlowService (dual-read)**: Built-in flows are loaded from the `data/flows/` directory at startup into an immutable `ReadonlyMap` cache. User flows are always read from the `flows` DB table on demand. `flow-service.ts` provides `getFlow()`, `listFlows()`, `getAllFlowIds()` — no mutable singleton Map, safe for horizontal scaling.
- **Flow versioning**: Every create/update of a user flow creates a snapshot in `flow_versions` (auto-incrementing `version_number` per flow via Drizzle transaction). Executions are tagged with `flow_version_id` for audit trail. Versions are non-blocking (errors caught and logged).
- **Flow packages (ZIP)**: User flows are stored as ZIP packages on the local filesystem (`storage/flow-packages/`). Each version upload contains `manifest.json`, `prompt.md`, and optional `skills/` and `extensions/` directories. The ZIP is mounted into the container and extracted by the entrypoint.
- **Skills & extensions storage**: Built-in items live in `data/skills/` and `data/extensions/`. For user flows, org items are stored in both DB (`org_skills.content` / `org_extensions.content`) and as ZIP packages in storage (`storage/library-packages/{orgId}/`). Built-in items cannot be edited or deleted via the API (403). At execution time, `buildUserFlowPackage()` injects them into the container. See the Flow Manifest Format section for file format details and SDK examples.

#### Infrastructure

- **Realtime via LISTEN/NOTIFY + SSE**: Execution status changes and log inserts trigger PostgreSQL `pg_notify()` via database triggers (installed at startup by `createNotifyTriggers()`). The backend listens on dedicated channels (`execution_update`, `execution_log_insert`) via a persistent `postgres` connection. SSE endpoints (`/api/realtime/*`) stream events to the frontend using `EventSource`. The frontend uses `useExecutionRealtime`, `useExecutionLogsRealtime`, `useFlowExecutionRealtime`, and `useAllExecutionsRealtime` hooks. A global `useGlobalExecutionSync` hook patches React Query cache directly from SSE events, avoiding full refetches.
- **Shared types**: Types used by both API and frontend live in `packages/shared-types/`. Derived from Drizzle schema (`@appstrate/db/schema`) via `InferSelectModel` + manual interfaces (`index.ts`). Backend re-exports them from `apps/api/src/types/index.ts`.
- **Structured logging**: All backend logging uses `lib/logger.ts` which emits JSON to stdout (`{ level, msg, timestamp, ...data }`). No `console.*` calls.
- **Rate limiting**: Token bucket middleware per `method:path:userId`. Applied on `POST /api/flows/:id/run` (20/min), `POST /api/flows/import` (10/min), `POST /api/flows` (10/min).
- **Graceful shutdown**: `execution-tracker.ts` tracks in-flight executions. On SIGTERM/SIGINT: stop scheduler → reject new POST requests → wait in-flight (max 30s) → exit.

## Architecture

```
User Browser (BrowserRouter SPA)  Platform (Bun + Hono :3010)
     |                                |
     |-- Login/Signup --------------->|-- Better Auth (email/password → cookie session)
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
├── scripts/
│   └── verify-openapi.ts             # OpenAPI spec verification: endpoint coverage + structural validation + lint (bun run verify:openapi)
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
│   │       ├── index.ts              # Hono app entry: CORS, Better Auth handler, cookie+API-key auth middleware, health route, shutdown gate, graceful shutdown, scheduler init, NOTIFY triggers, built-in providers/library init
│   │       ├── openapi/              # OpenAPI 3.1 spec — source of truth for all API endpoints
│   │       │   ├── index.ts          # Assembles all sub-modules into final spec via spread-merge
│   │       │   ├── info.ts           # openapi version, info, servers, security defaults, tags
│   │       │   ├── schemas.ts        # All #/components/schemas
│   │       │   ├── responses.ts      # All #/components/responses (Unauthorized, Forbidden, NotFound, etc.)
│   │       │   ├── parameters.ts     # All #/components/parameters (XOrgId)
│   │       │   ├── security-schemes.ts # cookieAuth, bearerApiKey, bearerExecToken
│   │       │   └── paths/            # One file per route domain (82 endpoints total)
│   │       │       ├── health.ts, auth.ts, flows.ts, executions.ts, realtime.ts
│   │       │       ├── schedules.ts, connections.ts, providers.ts, api-keys.ts
│   │       │       ├── library.ts, organizations.ts, profile.ts, invitations.ts
│   │       │       ├── share.ts, internal.ts, welcome.ts, meta.ts
│   │       │       └── (each exports Record<string, PathItemObject> with operationId on every op)
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
│   │       │   ├── api-keys.ts      # API key management: GET/POST /api/api-keys, DELETE /api/api-keys/:id (admin only)
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
│   │       │   ├── invitations.ts    # Invitation CRUD: create, accept, cancel, expire
│   │       │   └── api-keys.ts       # API key service: generate, hash, validate, create, list, revoke, cleanup
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
│           │   ├── use-api-keys.ts   # useApiKeys(), useCreateApiKey, useRevokeApiKey
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
│               ├── api-key-create-modal.tsx # Create org API key modal (name + expiration select, "Never" option)
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
│   │       ├── schema.ts             # Full Drizzle schema: 25 tables, enums, indexes, types
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

## API Reference

**The OpenAPI 3.1 spec is the single source of truth for all API endpoints.** It documents 82 endpoints with full request/response schemas, auth requirements, error codes, and SSE event formats.

- **Source files**: `apps/api/src/openapi/` — modular TypeScript files assembled at build time
- **Live spec**: `GET /api/openapi.json` (raw JSON) — public, no auth
- **Interactive docs**: `GET /api/docs` (Swagger UI) — public, no auth
- **Validation**: `bun run verify:openapi` — structural + lint (0 errors/warnings)

When working on API routes, always consult the corresponding OpenAPI path file in `apps/api/src/openapi/paths/` for the authoritative spec (schemas, auth, request/response format, error codes). Route domains: `health`, `auth`, `flows`, `executions`, `realtime`, `schedules`, `connections`, `providers`, `api-keys`, `library`, `organizations`, `profile`, `invitations`, `share`, `internal`, `welcome`, `meta`.

## Database Schema

Managed via Drizzle ORM. Full schema in `packages/db/src/schema.ts` (25 tables). Migrations via `drizzle-kit generate` + `drizzle-kit migrate`. No RLS — application-level security scopes all queries by `orgId`.

**Key tables and relationships:**

- **Auth**: `user`, `session`, `account`, `verification` (managed by Better Auth)
- **Multi-tenant**: `organizations` → `organization_members` (role: owner/admin/member) → `profiles` (display_name, language)
- **Flows**: `flows` (user-imported, org-scoped) → `flow_configs` (per org) → `flow_versions` (audit snapshots)
- **Execution**: `executions` (status, input, result, state, cost, duration, flow_version_id) → `execution_logs` (type, event, message, data). Both have NOTIFY triggers for realtime.
- **Scheduling**: `flow_schedules` (cron, timezone, enabled) → `schedule_runs` (distributed lock dedup)
- **Connections**: `provider_configs` (org-scoped, auth_mode, encrypted credentials, authorized_uris) → `service_connections` (per user+provider+flow) → `oauth_states` (short-lived PKCE)
- **Library**: `org_skills` / `org_extensions` (org-scoped) ↔ `flow_skills` / `flow_extensions` (junction)
- **Other**: `api_keys` (org-scoped, hash+prefix), `org_invitations` (magic links, 7-day expiry), `share_tokens`, `flow_admin_connections`

## Flow Manifest Format

Each flow is a directory with `manifest.json` + `prompt.md` + optional `skills/`. See `data/flows/pdf-explainer/manifest.json` for the reference implementation. Key sections:

- **schemaVersion**: Format version string (e.g. `"1.0.0"`)
- **metadata**: id (kebab-case slug), displayName, description, author — **all required**. Optional: license, tags.
- **requires.services[]**: Services needed — `{id, provider, scopes?, connectionMode?}`. `connectionMode` can be `"user"` (default) or `"admin"`.
- **requires.skills[]**: Skill IDs as `string[]` (e.g. `["greeting-style"]`)
- **requires.extensions[]**: Extension IDs as `string[]` (e.g. `["web-search"]`)
- **input.schema**, **output.schema**, **config.schema**: Standard JSON Schema objects with `type: "object"`, `properties: {}`, and optional `required: ["field1", "field2"]` **array at the object level**. Each property supports: `type` (`"string"`, `"number"`, `"boolean"`, `"array"`, `"object"`, `"file"`), `description`, `default`, `enum`, `format`, `placeholder`. File inputs also support: `accept`, `maxSize` (bytes), `multiple`, `maxFiles`. Do NOT use `required: true` on individual properties — use the top-level `required` array instead.
- **execution**: `timeout` (seconds), `outputRetries` (0-5, default 2 when output schema exists)

Example schema:
```json
{
  "input": {
    "schema": {
      "type": "object",
      "properties": {
        "text": { "type": "string", "description": "Text to analyze", "placeholder": "Enter text..." },
        "language": { "type": "string", "default": "french", "enum": ["french", "english"] }
      },
      "required": ["text"]
    }
  }
}
```

### Skills

Flows can include agent skills in `skills/{skill-id}/SKILL.md`. The SKILL.md file has YAML frontmatter with `name` and `description` fields. Skills are listed in the flow detail API response and their content is available inside the execution container at `.pi/skills/{skill-id}/SKILL.md`.

### Extensions

Extensions are TypeScript files that define Pi agent tools. They follow the **ExtensionFactory** pattern from the Pi SDK:

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function(pi: ExtensionAPI) {
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
      // params contains the tool parameters (e.g. params.input)
      const result = String(params.input);
      return { content: [{ type: "text" as const, text: result }] };
    },
  });
}
```

**Critical details:**
- **Import**: `@mariozechner/pi-coding-agent` (NOT `pi-agent`)
- **`execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** argument, NOT the first. Using `execute(args)` will receive the toolCallId string instead of the parameters.
- **Return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string or `JSON.stringify()`
- **Parameters**: Plain JSON Schema objects work (no need for Typebox `Type.Object()`, though Typebox is also supported)

## Container Protocol

The Pi runtime container streams JSON line events on stdout. The `PiAdapter` (`apps/api/src/services/adapters/pi.ts`) parses these events into `ExecutionMessage` types (progress, result, etc.).

The adapter orchestrates a **sidecar proxy pattern** for credential isolation:

1. Creates an isolated Docker network (`appstrate-exec-{execId}`)
2. Starts the sidecar container on both the default bridge (for host access) and the custom network (alias `sidecar`)
3. Starts the agent container on the custom network only — **no `EXECUTION_TOKEN`, no `PLATFORM_API_URL`, no `ExtraHosts`**
4. The agent calls `curl $SIDECAR_URL/proxy` with `X-Service` and `X-Target` headers for authenticated API requests
5. The sidecar fetches credentials from `GET /internal/credentials/:serviceId`, substitutes `{{variable}}` placeholders in headers and URL, validates the URL against `authorizedUris`, and forwards the full HTTP request (any method, any body). `authorized_uris` and `allow_all_uris` are configured per provider in `provider_configs`.
6. Both containers and the network are cleaned up in the `finally` block

**Prompt building**: `buildPromptContext()` in `env-builder.ts` assembles a typed `PromptContext` (raw prompt, tokens, config, previousState, executionApi, input, schemas). `buildEnrichedPrompt()` in `prompt-builder.ts` generates structured sections (`## User Input`, `## Configuration`, `## Previous State`, `## Execution History API`, etc.) enriched with schema metadata (types, descriptions, required), then appends the raw `prompt.md` at the end. No Handlebars — prompts are sent as-is.

**Container env vars**: `FLOW_PROMPT`, `LLM_PROVIDER`, `LLM_MODEL_ID`, `SIDECAR_URL`, `CONNECTED_SERVICES` (comma-separated service IDs, no secrets), and provider API keys. For user flows, the ZIP package from local storage is mounted into the container and extracted by the entrypoint (skills → `.pi/skills/`, extensions → loaded dynamically).

**Output validation loop**: When `output.schema` is defined in the manifest, the platform validates the extracted result with Zod (`validateOutput()`). On mismatch, it builds a retry prompt via `buildRetryPrompt()` describing the errors and expected schema, then re-executes the container. This repeats up to `execution.outputRetries` times. If validation still fails, the result is accepted as-is with a warning.

**State persistence**: If `result.state` is present, the platform persists it to the `state` column of the execution record. Only the latest execution's state is injected in the next run as `## Previous State` (lightweight). The agent can also fetch historical executions on demand via `$SIDECAR_URL/execution-history`.

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

- `turbo build` / `turbo check` / `turbo dev` all pass
- OpenAPI 3.1 spec: 82 endpoints, validated with `@readme/openapi-parser` + `@redocly/openapi-core` (0 errors/warnings)
- Drizzle migrations generated and applied (25 tables + NOTIFY triggers)

## Detailed Specs

The full product specifications are in the Obsidian vault at:

```
/Users/pierrecabriere/Library/Mobile Documents/iCloud~md~obsidian/Documents/main/projects/claude-flows/
├── claude-flows-mvp.md              # MVP scope, architecture, milestones
├── claude-flows-mvp-api.md          # API spec with all endpoints, payloads, SSE events, error codes
├── claude-flows-mvp-flow-format.md  # Flow package format: manifest spec, prompt template syntax
└── claude-flows-mvp-first-flow.md   # email-to-tickets flow: functional spec, prompt, test scenarios
```
