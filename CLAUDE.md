# Appstrate — Developer Guide

Appstrate is an open-source platform for running autonomous AI agents in sandboxed Docker containers. A user signs up, connects OAuth/API key services (Gmail, ClickUp), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Agents can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

## Quick Start

**Tier 0 (zero-install — recommended for development):**

```sh
cp .env.example .env
bun run dev                   # PGlite + filesystem + in-memory → :3000
```

No Docker, no PostgreSQL, no Redis. After signup, the onboarding flow guides the user to create their first organization.

**Tier 3 (full stack with Docker):**

```sh
bun run setup                 # Interactive tier selection, starts Docker, migrates DB, builds
bun run dev
```

### Docker Compose (Tier 1-3)

- **`docker-compose.dev.yml`** — Development services with profiles:
  - `bun run docker:dev:minimal` — Tier 1: PostgreSQL only
  - `bun run docker:dev:standard` — Tier 2: PostgreSQL + Redis
  - `bun run docker:dev` — Tier 3: PostgreSQL + Redis + MinIO
- **`docker-compose.yml`** — Self-hosting / production (images from GHCR)
- **`docker:prod`** script — `docker compose --profile prod up -d` (full stack)

## Stack — Critical Constraints

| Constraint     | Details                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **Bun** everywhere — NOT node. Bun auto-loads `.env`                                                                                                                                                                                                                                                                                                                                                |
| API framework  | **Hono** — NOT `Bun.serve()` (need SSE via `streamSSE`, routing, middleware)                                                                                                                                                                                                                                                                                                                        |
| Docker client  | **`fetch()` + unix socket** — NOT dockerode (socket bugs with Bun). See `services/docker.ts`                                                                                                                                                                                                                                                                                                        |
| DB security    | **No RLS** — app-level security, all queries filter by `orgId` (+ `applicationId` for app-scoped resources)                                                                                                                                                                                                                                                                                         |
| Logging        | **`lib/logger.ts`** (JSON to stdout) — no `console.*` calls                                                                                                                                                                                                                                                                                                                                         |
| Auth           | **Better Auth** cookie sessions + `X-Org-Id` header + `X-App-Id` header (app-scoped routes). Email/password + optional Google social login (opt-in via env vars). Optional email verification (opt-in via SMTP env vars). Account linking with trusted providers. API key auth (`ask_` prefix) tried first, then cookie fallback. `Appstrate-User` header for end-user impersonation (API key only) |
| Validation     | **Zod 4** for all request body/query validation + JSONB safe narrowing. **AJV** only for dynamic manifest schemas                                                                                                                                                                                                                                                                                   |
| Env validation | **`@appstrate/env`** (Zod schema) is the single source of truth — not `.env.example`                                                                                                                                                                                                                                                                                                                |
| Redis          | **Redis 7+** — BullMQ scheduler, distributed rate limiting (`rate-limiter-flexible`), cancel Pub/Sub, OAuth PKCE state                                                                                                                                                                                                                                                                              |
| Storage        | **S3** (`@aws-sdk/client-s3`) via `@appstrate/core/storage-s3` — configurable endpoint for MinIO/R2                                                                                                                                                                                                                                                                                                 |

## Navigating the Codebase

```
appstrate/
├── apps/api/src/             # @appstrate/api — Hono backend (:3000)
│   ├── index.ts              # Entry: middleware, auth, startup init, SPA config injection
│   ├── lib/
│   │   ├── cloud-loader.ts   # Dynamic import of @appstrate/cloud (optional EE module)
│   │   └── boot.ts           # Boot sequence (loadModules → system init → scheduler)
│   ├── routes/               # Route handlers (one file per domain)
│   ├── services/             # Business logic, Docker, adapters, scheduler
│   ├── openapi/              # OpenAPI 3.1 spec (source of truth for all endpoints)
│   │   ├── headers.ts        # Reusable response header definitions
│   │   └── paths/            # One file per route domain (191 endpoints)
│   └── types/                # Backend types + re-exports from shared-types
│
├── apps/web/src/             # @appstrate/web — React 19 + Vite + React Query v5
│   ├── pages/                # Route pages (React Router v7 BrowserRouter)
│   ├── hooks/                # React Query hooks + SSE realtime hooks
│   ├── components/           # UI components (modals, forms, editors)
│   ├── stores/               # Zustand stores (auth-store, org-store, app-store, sidebar-store, theme-store)
│   ├── lib/                  # Utilities (auth-client, markdown, provider-status, strings)
│   ├── styles.css            # Tailwind 4 CSS (dark theme, custom @theme inline)
│   └── i18n.ts               # i18next: fr (default) + en, namespaces: common/agents/settings
│
├── packages/db/src/          # @appstrate/db — Drizzle ORM + Better Auth
│   ├── schema.ts             # Full schema (31 tables, 5 enums, indexes) — barrel re-export from schema/
│   ├── client.ts             # db + listenClient (LISTEN/NOTIFY)
│   └── auth.ts               # Better Auth config (email/password, Google social, email verification, account linking)
│
├── packages/emails/src/      # @appstrate/emails — Email template registry + rendering
│   ├── types.ts              # EmailType, EmailRenderer, RenderedEmail, SupportedLocale
│   ├── registry.ts           # renderEmail + registerEmailOverrides (cloud override mechanism)
│   └── templates/            # Layout + per-type templates (verification, invitation)
│
├── packages/core/            # @appstrate/core — shared validation, storage, utilities
├── packages/env/src/         # @appstrate/env — Zod env validation (authoritative)
├── packages/shared-types/    # @appstrate/shared-types — Drizzle InferSelectModel re-exports
├── packages/connect/         # @appstrate/connect — OAuth2/PKCE, API key, credential encryption
│
├── system-packages/           # System package ZIPs (providers, skills, tools, agents — loaded at boot)
│
├── runtime-pi/               # Docker image: Pi Coding Agent SDK
│   ├── entrypoint.ts         # SDK session → JSON lines on stdout
│   └── sidecar/server.ts     # Credential-isolating HTTP proxy (Hono)
│
└── scripts/verify-openapi.ts # bun run verify:openapi
```

**Workspace imports**: `@appstrate/core/*` (validation, zip, naming, dependencies, integrity, semver, version-policy, system-packages, form, schemas, logger, env, storage, ssrf, dist-tags), `@appstrate/db/schema`, `@appstrate/db/client`, `@appstrate/emails`, `@appstrate/env`, `@appstrate/connect`, `@appstrate/shared-types`.

## Architecture

```
User Browser (BrowserRouter SPA)  Platform (Bun + Hono :3000)
     |                                |
     |-- Login/Signup --------------->|-- Better Auth (email/password + optional Google social → cookie session)
     |                                |
     |-- / (Agent List) ------------->|-- GET /api/agents (with runningRuns count)
     |-- /agents/:id (Agent Detail) ->|-- GET /api/agents/:id (with services, config, state, skills)
     |-- PUT /api/agents/:id/config ->|-- schema.ts (AJV validation) → state.ts (Drizzle)
     |-- POST /api/connections/connect/:prov -->|-- connection-manager.ts → OAuth2 flow / API key storage
     |                                |
     |-- POST /api/agents/:id/run --->|
     |                                |-- 1. Validate deps, config, input (AJV)
     |                                |-- 2. Create run record (pending, user_id)
     |                                |-- 3. Fire-and-forget: executeAgentInBackground()
     |                                |-- 4. Output validation loop (if output schema)
     |<-- SSE (replay + live) --------|-- 5. Subscribe to logs via pub/sub
     |                                |
     |   Realtime (LISTEN/NOTIFY):    |-- pg_notify triggers on runs + run_logs
     |   EventSource → SSE endpoints  |-- useRunRealtime() + useRunLogsRealtime()
     |   + useGlobalRunSync()         |-- Patches React Query cache directly (no refetch)
     |                                |
     |   Background Run:              |-- Runs independently of SSE client
     |                                |-- Persists logs to run_logs table
     |                                |-- Supports concurrent runs per agent
     |                                |
     |   Scheduler (BullMQ + Redis):   |-- Distributed cron via BullMQ repeatable jobs
     |                                |-- Worker processes jobs → triggerScheduledRun()
     |                                |-- Exactly-once guaranteed (Redis atomic dequeue)
     |                                |-- Uses same executeAgentInBackground() path
     |                                |
     |            Sidecar Pool (pre-warmed):  |-- initSidecarPool() at startup
     |            - SIDECAR_POOL_SIZE standby  |-- acquireSidecar() → /configure → attach
     |              appstrate-sidecar-pool net |-- replenish in background after acquire
     |                                        |-- shutdownSidecarPool() on exit
     |                                |
     |            Docker network: appstrate-exec-{runId} (isolated bridge)
     |            Sidecar + Agent setup run in parallel (Promise.all)
     |            ┌─────────────────────────────────────────────┐
     |            │  Sidecar Container (alias: "sidecar")       │
     |            │  - RUN_TOKEN, PLATFORM_API_URL              │
     |            │  - Configured via env vars (fresh) or       │
     |            │    POST /configure (pooled pre-warmed)      │
     |            │  - Proxies /proxy → credential injection    │
     |            │  - Proxies /run-history                     │
     |            │  - ExtraHosts → host.docker.internal        │
     |            ├─────────────────────────────────────────────┤
     |            │  Agent Container (Pi Coding Agent, Bun)     │
     |            │  - AGENT_PROMPT, LLM_*, SIDECAR_URL          │
     |            │  - NO RUN_TOKEN, NO PLATFORM_API_URL        │
     |            │  - NO ExtraHosts (cannot reach host)        │
     |            │  - Files injected before start (parallel)   │
     |            │  - Calls sidecar via curl for API access    │
     |            │  - Outputs JSON lines on stdout             │
     |            └─────────────────────────────────────────────┘
```

## Key Conventions & Gotchas

### Module System

Appstrate uses a formalized module system for optional features. The contract is defined in `@appstrate/core/module` (published on npm) so external modules can implement it without depending on the API package.

**Key files:**

- `packages/core/src/module.ts` — `AppstrateModule` interface, `ModuleInitContext`, hook & event type maps (framework-agnostic, published on npm)
- `apps/api/src/lib/modules/module-loader.ts` — Loader with built-in auto-discovery, dynamic import, topological sort, hook/event dispatch, AppConfig extension, shutdown
- `apps/api/src/lib/modules/migrate.ts` — `applyModuleMigrations()` helper for module-owned Drizzle migrations (PostgreSQL + PGlite, per-module tracking tables, advisory-lock serialization)
- `apps/api/src/lib/modules/registry.ts` — `getModuleRegistry()` reads `APPSTRATE_MODULES` env var (comma-separated specifiers), `buildModuleInitContext()` provides platform services
- `apps/api/src/modules/README.md` — Authoring guide for built-in modules, plus per-module READMEs next to each `index.ts`

Lifecycle hooks/events are invoked directly via `callHook("beforeRun", …)` / `emitEvent("onRunStatusChange", …)` from `module-loader.ts` — there is no separate helpers layer.

**Built-in module resolution:** The loader resolves each specifier in `APPSTRATE_MODULES` by looking for a matching `apps/api/src/modules/<specifier>/index.ts` directory first, then falling back to a dynamic npm import. No registration table, no hardcoded list — adding a new built-in module is as simple as dropping a new directory under `apps/api/src/modules/` and adding its id to `APPSTRATE_MODULES`. `scripts/verify-openapi.ts` does its own filesystem scan of the same directory to enumerate built-ins for OpenAPI validation.

**Module lifecycle:** core migrations → auto-discover built-ins → registry (`APPSTRATE_MODULES` env var) → dynamic import → topological sort by `manifest.dependencies` → `init(ctx)` (runs module migrations + workers) → `createRouter()` → running → `shutdown()` (reverse order). All declared modules are required — any import or init failure is fatal. RBAC is not part of the lifecycle: permissions are declared statically in core and consumed by modules through the typed `requirePermission` helper.

**Module-owned schemas:** Each built-in module owns its database tables following the cloud pattern. Module schemas live in `apps/api/src/modules/<name>/schema.ts` with Drizzle migrations in `drizzle/migrations/`. Each module has its own migration tracking table (`__drizzle_migrations_<module_id>`). Modules apply their migrations in `init()` via `applyModuleMigrations()`.

| Module   | Tables owned                     |
| -------- | -------------------------------- |
| webhooks | `webhooks`, `webhook_deliveries` |

Scheduling and provider management both live in core (scheduler in `apps/api/src/services/scheduler.ts` + `package_schedules` table, models/provider-keys in `apps/api/src/services/org-models.ts` + `apps/api/src/services/org-provider-keys.ts` + `org_models`/`org_provider_keys` tables in `packages/db/src/schema/provider-keys.ts`). Both were briefly extracted as modules during the `feat/platform-modules` iteration, then moved back once it became clear that the coupling with `runs` (FK, filtering, enrichment, realtime, model resolution on the hot path) made module isolation cost more than it delivered. Only webhooks remains a module because it has a truly clean boundary with core — a single `onRunStatusChange` event listener, no reach-backs, isolated BullMQ delivery worker.

**FK direction rule:** Backward references (module → core) use Drizzle `.references()` inline in the module schema — safe because core tables always exist before any module migration runs. Forward references (core → module) are impossible to express via Drizzle without leaking the module schema into core, so if a future module ever needs one it must add it via raw SQL inside its own migration. Core schemas never reference module-owned tables.

**Hooks vs Events:**

- **Hooks** (`callHook`): First-match-wins. Naming: `beforeX` (gates), `afterX` (post-lifecycle). Example: `beforeRun` blocks a run with a structured error; `afterRun` returns a metadata patch persisted on the run record (used by cloud for credit accounting).
- **Events** (`emitEvent`): Broadcast-to-all, side effects only. Naming: `onX` (something happened, modules react). Example: `onRunStatusChange`, `onOrgCreate`, `onOrgDelete`. Errors in individual handlers are isolated.

The platform calls hooks/events by name, never by module ID. This ensures zero knowledge of module internals.

**Permissions & API key scopes:** RBAC is a platform capability, not a module concern. Core's `apps/api/src/lib/permissions.ts` is the single typed source of truth — it ships the full `Permission` union (including `webhooks:*`, `models:*`, `provider-keys:*`), the role-to-permission matrix, and the API key allowlist. Module manifests do not declare `permissions` or `apiKeyScopes`. Module routes protect handlers with the same typed `requirePermission("webhooks", "write")` helper core uses, so adding a new resource requires editing `permissions.ts` and the route in the same PR.

**Creating a new built-in module:** Drop a directory under `apps/api/src/modules/<name>/` with an `index.ts` exporting a default `AppstrateModule`. Discovery picks it up automatically. The module contributes feature flags via `features`, routes via `createRouter()`, auth-bypass paths via `publicPaths`, email template overrides via `emailOverrides`, request/response logic via `hooks` (`beforeRun`, `afterRun`, `beforeSignup`), notifications via `events` (`onRunStatusChange`, `onOrgCreate`, `onOrgDelete`), and database tables via module-owned Drizzle migrations. If the module introduces a new RBAC resource, extend `apps/api/src/lib/permissions.ts` in the same PR. To ship as an external npm package instead, export the same default and set `APPSTRATE_MODULES=@scope/name`.

**Disabling a module = zero footprint:** remove it from `APPSTRATE_MODULES` and it is neither imported nor initialized. No tables, no routes, no middleware, no hook handlers, no feature flags. Core knows nothing about the module's existence. Default is empty (OSS mode).

### Progressive Infrastructure

Appstrate uses a tiered infrastructure model — every external dependency is optional with a built-in fallback:

| Component                     | When absent                     | Fallback                       | Tier required |
| ----------------------------- | ------------------------------- | ------------------------------ | ------------- |
| PostgreSQL (`DATABASE_URL`)   | PGlite (embedded WASM Postgres) | `./data/pglite/`               | 1+            |
| Redis (`REDIS_URL`)           | In-memory adapters              | EventEmitter, Map, local queue | 2+            |
| S3/MinIO (`S3_BUCKET`)        | Filesystem storage              | `./data/storage/`              | 3             |
| Docker (`RUN_ADAPTER=docker`) | Bun subprocesses                | No container isolation         | 3             |

Tier 0 (zero-install) requires only Bun. Infrastructure adapters are in `apps/api/src/infra/` with dynamic imports to avoid loading Redis/BullMQ when not configured.

### Development Workflow

- **New API route**: Create route file in `routes/` + OpenAPI path file in `openapi/paths/` + wire in `index.ts`. Run `bun run verify:openapi` to validate.
- **DB migration (core)**: Edit `packages/db/src/schema.ts` → `bun run db:generate` (requires `DATABASE_URL` for drizzle-kit CLI). Migrations are applied automatically at boot for both PGlite and PostgreSQL — no manual `db:migrate` needed.
- **DB migration (module)**: Each built-in module owns its schema in `apps/api/src/modules/<name>/schema.ts` with migrations in `drizzle/migrations/`. Module migrations run automatically in `init()` via `applyModuleMigrations()`.
- **Quality gate**: `bun run check` (turbo check = TypeScript across all packages + `verify-openapi` structural/lint validation).
- **Tests**: `bun test` from monorepo root runs all 1000+ tests across all packages in a single process. See **Testing** section below for structure, conventions, and patterns.

### Frontend

- **i18n**: `i18next` with `react-i18next`. Default: `fr`, supported: `fr`/`en`. Namespaces: `common`, `agents`, `settings`. Locales in `apps/web/src/locales/{lang}/`.
- **Styling**: Tailwind 4 CSS (`@tailwindcss/vite` plugin + `tailwind-merge`). Single `styles.css` with `@import "tailwindcss"` and custom `@theme inline` dark theme variables. All components use Tailwind utility classes.
- **Auth**: Better Auth React client → `credentials: "include"` on all `apiFetch()` calls. `X-Org-Id` header for org context, `X-App-Id` header for app context (sent automatically from `app-store` via `api.ts`).
- **Realtime**: SSE EventSource hooks (`use-realtime.ts`) + `useGlobalRunSync` patches React Query cache directly. `useGlobalRunSync` deliberately uses `fetch()` + `ReadableStream` (NOT `EventSource`) to avoid Safari aggressive auto-reconnect — do not convert it. `GlobalRealtimeSync` is mounted inside `MainLayout` (not on onboarding/welcome routes) to avoid SSE reconnection loops when org state is settling.
- **Feature gating**: `useAppConfig()` hook reads `window.__APP_CONFIG__` (injected into HTML at serve time via `<script>` tag, computed once at boot by `buildAppConfig()`). Returns `{ features: { billing, models, providerKeys, scheduling, webhooks, googleAuth, githubAuth, smtp } }`. No API call — falls back to OSS defaults (all `false`) if undefined. Used to conditionally render routes, nav items, dashboard widgets, and onboarding steps. Module-owned features (models, providerKeys, scheduling, webhooks) default to `false` and are enabled when their module is loaded. Sidebar, routes, and tabs are fully gated — disabled modules have zero UI footprint.
- **API helpers** (`api.ts`): `api<T>(path)` prepends `/api` + JSON parse; `apiFetch<T>(path)` raw path (for `/auth/*`); `uploadFormData<T>(path, formData)` for file uploads — never set `Content-Type` manually (browser sets multipart boundary); `apiBlob(path)` for binary downloads. All inject `X-Org-Id`, `X-App-Id` (from `app-store`), and `credentials: "include"`.
- **React Query keys**: Org-scoped `[entity, orgId, id?]` or app-scoped `[entity, orgId, appId, id?]` for app-scoped resources (agents, runs, schedules, webhooks). Examples: `["agents", orgId, appId]`, `["runs", orgId, appId, packageId]`. Non-app-scoped: `["orgs"]` (global), `["connections", orgId]`. On org switch, `queryClient.removeQueries` wipes all except `["orgs"]`.
- **Standard components**: Always use `<Modal>` (`components/modal.tsx`) for dialogs — never build raw overlays. Use `<LoadingState>`, `<ErrorState>`, `<EmptyState>` from `page-states.tsx` for page states. Use `<InputFields>` for JSON Schema-driven forms, `<FileField>` for uploads.

### Backend

- **Multi-tenant**: All DB queries filter by `orgId`. App-scoped resources (agents, runs, schedules, webhooks, connections, end-users, api-keys, notifications, packages) additionally filter by `applicationId`. Admins = org role `admin` or `owner`.
- **Service layer**: All function-based (no classes). `state.ts` is the central data-access layer (runs, logs, config, agent provider bindings). Drizzle ORM with `import { db } from "../lib/db.ts"` and schema from `@appstrate/db/schema`.
- **Request pipeline**: error handler → Request-Id → CORS → health check (`/`) → OpenAPI docs → shutdown gate → Better Auth (`/api/auth/*`) → auth middleware (API key `ask_` first, then cookie → `Appstrate-User` resolution if present) → org context middleware (`X-Org-Id` → verify membership) → app context middleware (`X-App-Id` → verify app belongs to org, required for app-scoped routes: agents, runs, schedules, webhooks, end-users, api-keys, notifications, packages, providers, connections, app-profiles; realtime handles app-scoping internally via query param) → API version middleware (`Appstrate-Version` header) → route handler (per-route: `rateLimit()`, `idempotency()`) → cloud routes (if loaded).
- **Platform config** (`buildAppConfig()` in `index.ts`): Computed once at boot. Serialized as `window.__APP_CONFIG__` and injected into `index.html` via `<script>` tag at serve time (`app.get("/*")`). Config is static — `useAppConfig()` reads it synchronously. All module-owned features default to `false` and are enabled by their respective modules via `features` property. `googleAuth`, `githubAuth`, and `smtp` flags are derived from env var presence (opt-in).
- **Cloud module**: Loaded via the module system when `APPSTRATE_MODULES=@appstrate/cloud` is set. All declared modules are required — if declared but not installed, the platform crashes at boot. Default is empty (OSS mode). `getModule("cloud")` returns the loaded module or `null`.
- **Cost tracking**: `runs.cost` (doublePrecision) stores the dollar cost per run. Cost chain: `SYSTEM_PROVIDER_KEYS` cost config → `ModelDefinition.cost` → `ResolvedModel.cost` → `PromptContext.llmConfig.cost` → `MODEL_COST` env var in Pi container → Pi SDK calculates cost → `RunMessage.cost` → accumulated and persisted. DB models (`org_models`) also support optional `cost` (jsonb) for self-hosted cost tracking. OpenRouter models auto-populate cost from pricing API.
- **Hono context** (`c.get(...)`): `user` (id, email, name), `orgId`, `orgRole` ("owner"/"admin"/"member"), `authMethod` ("session"/"api_key"), `apiKeyId`, `applicationId` (set by `requireAppContext()` from `X-App-Id` header, or from API key's `applicationId`), `endUser` (set via `Appstrate-User` header — `{ id, applicationId, name?, email? }`), `apiVersion` (resolved by api-version middleware), `agent` (set by `requireAgent()`).
- **Route guards** (`middleware/guards.ts`): `requireAdmin()` → 403 if not admin/owner; `requireOwner()` → 403 if not owner; `requireAgent(param)` → loads agent + sets `c.set("agent")`, 404 if missing; `requireMutableAgent()` → also checks not system package + no running runs. **App context** (`middleware/app-context.ts`): `requireAppContext()` → validates `X-App-Id` header (session auth) or uses API key's `applicationId`, verifies app belongs to org, sets `c.set("applicationId")`. Required for app-scoped routes: agents, runs, schedules, webhooks, end-users, api-keys, notifications, packages, providers, connections, app-profiles.
- **Rate limiting**: Redis-backed via `rate-limiter-flexible` (`RateLimiterRedis`). Keyed by `method:path:identity` where identity is `userId` for sessions or `apikey:{apiKeyId}` for API keys. IP-based (`ip:method:path:ip`) for public unauthenticated routes. Returns IETF `RateLimit` structured header (`limit=N, remaining=M, reset=S`) + `RateLimit-Policy` + `Retry-After` headers. Key limits: run (20/min), import (10/min), create (10/min).
- **Route registration order**: `userAgentsRouter` MUST be registered before `agentsRouter` in `index.ts` — Hono matches in order.
- **Docker streams**: Multiplexed 8-byte frame headers `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`.
- **Package versioning**: Semver-based version system across `package-versions.ts`, `package-version-deps.ts`, and `package-storage.ts`. Key tables: `packageVersions` (version, integrity, manifest snapshot, yanked), `packageDistTags` (named pointers like "latest"), `packageVersionDependencies` (per-version skill/tool deps). Semver enforcement via `@appstrate/core/version-policy` (`validateForwardVersion` — forward-only, no downgrades). "latest" dist-tag auto-managed on non-prerelease publishes. Custom dist-tags via `addDistTag`/`removeDistTag` (protected: "latest" cannot be set/removed manually). Yank support via `yankVersion` (sets `yanked: true`, reassigns affected dist-tags to best stable version). 3-step version resolution: exact match → dist-tag lookup → semver range (`resolveVersionFromCatalog`). Integrity: SHA256 SRI hash computed via `@appstrate/core/integrity`. Per-version dependencies stored via `storeVersionDependencies` (extracted with `@appstrate/core/dependencies`). All versioning columns included in the initial squashed migration.
- **Providers as packages**: Providers (OAuth/API services) are the 4th package type (`type: "provider"`) alongside agents, skills, and tools. Provider definition lives in `packages.manifest.definition` (JSONB). System providers loaded from ZIP files in `system-packages/` at boot via `system-packages.ts`. Credentials stored in `applicationProviderCredentials` table keyed by `(applicationId, providerId)`. Routes in `routes/providers.ts` (GET list, POST create, PUT update, DELETE). OAuth/credential logic in `@appstrate/connect` (`packages/connect/src/registry.ts`).
- **AgentService**: All agents (system + local) stored in DB. System agents loaded from ZIPs at boot and synced to DB with `orgId: null`.
- **Graceful shutdown**: `run-tracker.ts` — stop scheduler + sidecar pool → reject new POST → wait in-flight (max 30s) → exit.
- **Validation (Zod)**: All route request bodies MUST be validated with `parseBody(schema, body)` from `lib/errors.ts`. This helper calls `.safeParse()` and throws `invalidRequest()` on failure. Pattern: define schema in the route file (or service file if reused), call `const data = parseBody(mySchema, body)`. Optional third `param` argument for field-specific errors. Reference implementations: `routes/models.ts`, `routes/webhooks.ts`, `routes/organizations.ts`. Naming: `{concept}Schema` for Zod objects (e.g. `createWebhookSchema`), `{Concept}` for inferred types via `z.infer<>`. For JSONB columns read from DB, use safe narrowing helpers (null/typeof/Array.isArray guards) instead of raw `as` casts. For query parameters, use `z.coerce.number().int().min().max().catch(default).parse()`. The codebase uses **Zod 4** — use `z.url()` (NOT `z.string().url()`), `z.uuid()`, etc. See `docs/architecture/ZOD_SCHEMA_AUDIT.md` for the full audit and patterns.
- **Validation (AJV)**: `validateConfig()`, `validateInput()`, and `validateOutput()` use AJV for **dynamic** schemas (agent config/input/output defined in manifests). AJV coexists with Zod — use AJV only for schemas that come from user-defined manifest configuration, Zod for everything else. All three share one AJV instance with `coerceTypes: true` (e.g. `"50"` accepted as number). Extra fields always allowed (no `additionalProperties: false`).

### Headless Developer Platform

Appstrate exposes a headless API for developers to integrate agents into their own apps. See `docs/specs/HEADLESS_DEVELOPER_PLATFORM.md` for the full spec.

- **Applications**: Table `applications` (prefix `app_`). Each org has a default application (`isDefault: true`, unique index). API keys are scoped to an application. Routes: `/api/applications` (CRUD, admin-only).
- **End-users**: Table `end_users` (prefix `eu_`). External users managed via API, belonging to an application. Not Better Auth users — separate table, no password, no dashboard login. Routes: `/api/end-users` (CRUD, admin-only). Fields: `externalId` (unique per app), `metadata` (JSONB, max 50 keys, 40 char key, 500 char value), `email`, `name`. Each end-user gets a default connection profile on creation.
- **`Appstrate-User` header**: Impersonation header (pattern: Stripe `Stripe-Account`). Value: `eu_` prefixed ID. API key auth only — rejected with `400` on cookie auth. Validates that the end-user belongs to the API key's application. Sets `c.set("endUser")` in context. Full audit log on each impersonation (requestId, apiKeyId, endUserId, applicationId, IP, userAgent).
- **Webhooks**: Tables `webhooks` (prefix `wh_`) and `webhookDeliveries`. All webhooks are application-scoped via `applicationId` (`NOT NULL`). Standard Webhooks spec (HMAC-SHA256 signing). BullMQ async delivery with 8-attempt exponential backoff. Event types: `run.started`, `run.success`, `run.failed`, `run.timeout`, `run.cancelled`. Payload modes: `full` (includes result/input) and `summary`. SSRF protection on webhook URLs. Secret rotation with 24h grace period. Routes: `/api/webhooks` (CRUD + test/ping + rotate + deliveries, admin-only). List supports `?applicationId=` query filter.
- **Application packages**: Table `application_packages` — installed packages per application with config overrides, model/proxy overrides, and version pinning. Replaces the old `package_configs` table. Agent config is now per-application (not per-org).
- **API versioning**: Date-based (pattern: Stripe). Current: `2026-03-21`. Header `Appstrate-Version` (request override + always in response). Org-level pinning via `settings.apiVersion`. `Sunset` header on deprecated versions. Middleware: `middleware/api-version.ts`.
- **Idempotency**: Header `Idempotency-Key` on POST routes (end-users, webhooks, agent run). Redis-backed, 24h TTL, SHA-256 body hash for conflict detection. Returns `409` on concurrent, `422` on body mismatch, `Idempotent-Replayed: true` header on cached replay. Middleware: `middleware/idempotency.ts`.
- **Error handling**: RFC 9457 `application/problem+json` on all endpoints (not just headless). `ApiError` class with factory helpers (`invalidRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `gone`, `internalError`, `systemEntityForbidden`). `systemEntityForbidden(type, id, verb?)` for "Cannot modify/delete built-in X" errors. `parseBody(schema, body, param?)` for Zod validation (throws `invalidRequest` on failure). Custom `headers` field on `ApiError` for rate-limit headers. `Request-Id` (`req_` prefix) on all responses.
- **SSE + API key**: SSE endpoints accept API key via `?token=ask_...` query param (EventSource can't send headers). Cookie auth fallback preserved.

### Sidecar Protocol (details beyond the architecture diagram)

- **Sidecar pool**: `sidecar-pool.ts` pre-warms sidecar containers at startup on a standby network (pool size configurable via `SIDECAR_POOL_SIZE`, default 2, 0 to disable). `acquireSidecar()` configures a pooled container via `POST /configure` (sets `runToken`, `platformApiUrl`, `proxyUrl`), then connects it to the run network. Falls back to fresh creation if pool is empty or configuration fails. Pool replenishes in background after each acquisition.
- **Parallel startup**: `pi.ts` runs sidecar setup (pool acquire or fresh create) in parallel with agent container creation + file injection via `Promise.all`. Files are batch-injected as a single tar archive before `startContainer()`.
- Agent calls `$SIDECAR_URL/proxy` with `X-Provider`, `X-Target`, optional `X-Proxy`, and optional `X-Substitute-Body` headers for authenticated API requests.
- Sidecar substitutes `{{variable}}` placeholders in headers/URL/proxy (and request body if `X-Substitute-Body: true`), validates against `authorizedUris` per provider.
- **Proxy cascade**: Outbound requests route through proxies in priority order: `X-Proxy` header (agent-driven) → `PROXY_URL` env var (infrastructure). Agent-level and org-level proxy config is resolved by the platform before container creation.
- **Transparent pass-through**: Sidecar forwards upstream responses as-is (HTTP status code + body + Content-Type). Truncation (>50KB) signaled via `X-Truncated: true` header. Sidecar-specific errors (credential fetch, URL validation) return JSON `{ error }` with 4xx/5xx status.
- **Prompt building**: `buildEnrichedPrompt()` generates sections (User Input, Configuration, Previous State, Run History API) + appends raw `prompt.md`. No Handlebars.
- **Output validation**: If `output.schema` exists, it is injected into the agent container via `OUTPUT_SCHEMA` env var for native LLM schema enforcement (constrained decoding). Post-run, AJV validates the merged result. On mismatch, a warning is logged but the run still succeeds.
- **State persistence**: `result.state` → persisted to run record. Only latest state injected as `## Previous State` next run. Historical runs available via `$SIDECAR_URL/run-history`.

## Testing

### Running Tests

```sh
bun test                          # All tests (1000+), all packages, single process
bun test apps/api/test/unit/      # API unit tests only
bun test apps/api/test/           # API unit + integration
bun test runtime-pi/              # Runtime Pi + sidecar tests
bun test packages/core/           # Core library tests (367+ tests, no DB)
bun test packages/connect/        # Connect package tests
```

Requires Docker (PostgreSQL, Redis, MinIO, DinD started automatically by preload).

### Configuration

Single `bunfig.toml` at monorepo root — no per-package bunfig:

```toml
[test]
preload = ["./test/setup/preload.ts"]   # Starts Docker infra, sets env, runs migrations
timeout = 15000
```

The preload (`test/setup/preload.ts`) is shared infrastructure: Docker Compose (PostgreSQL on :5433, Redis on :6380, MinIO on :9002, DinD on :2375), env vars, Drizzle migrations, alpine image pre-pull. Non-API tests (runtime-pi, connect) don't use the DB but the overhead is negligible (~5s one-time).

### Test Structure

All packages use `test/` directories (not `__tests__/` or `tests/`):

```
apps/api/test/
├── unit/                  # Pure logic, no DB (guards, parsers, validators, prompt builder)
├── integration/
│   ├── middleware/         # org-context, guards (with real DB)
│   ├── routes/            # HTTP integration per route domain + error-paths.test.ts
│   └── services/          # Service-level (Docker API, scheduler, OAuth, packages)
└── helpers/               # Shared test utilities (app, auth, db, seed, assertions, sse, redis, oauth-server)

apps/web/src/**/test/      # Frontend unit tests (colocated with components)
runtime-pi/test/           # Extension wrapper tests
runtime-pi/sidecar/test/   # Sidecar proxy, helpers, forward proxy tests
packages/core/test/        # Core library tests (367+ pure function tests, no DB/network)
packages/connect/test/     # Provider doc heuristic tests
```

### Conventions

| Convention    | Rule                                                                |
| ------------- | ------------------------------------------------------------------- |
| Framework     | `bun:test` — NOT vitest/jest                                        |
| Test function | `it()` — NOT `test()` (consistent across all packages)              |
| Import order  | `import { describe, it, expect, beforeEach, mock } from "bun:test"` |
| File naming   | `*.test.ts` — NOT `*.spec.ts`                                       |
| Isolation     | `beforeEach(async () => { await truncateAll(); })` for DB tests     |
| App testing   | `app.request()` via Hono — NOT `Bun.serve()`, no port binding       |
| Auth in tests | Real Better Auth sign-up → session cookie (not mock auth)           |
| DB cleanup    | `DELETE FROM` in FK-safe order (not `TRUNCATE` — avoids deadlocks)  |

### Mocking Policy — No `mock.module()`

**Never use `mock.module()` in this codebase.** It replaces the entire module globally and permanently within a test run, breaking other tests that import from the same barrel export. This was the source of 37 test failures that were difficult to diagnose.

**Use dependency injection instead:**

```typescript
// ✅ Good — optional deps parameter with production defaults
export async function validateAgentDependencies(
  providers: AgentProviderRequirement[],
  profiles: Record<string, string>,
  orgId: string,
  deps: DependencyValidationDeps = defaultDeps,  // Tests inject mocks here
): Promise<void> { ... }

// ✅ Good — constructor injection
export class PiAdapter implements RunAdapter {
  constructor(orchestrator?: ContainerOrchestrator) {
    this._orchestrator = orchestrator;  // Tests inject mock, production uses default
  }
}

// ✅ Good — function parameter (runtime-pi pattern)
export function wrapExtensionFactory(
  factory: ExtensionFactory,
  extensionId: string,
  emitFn: EmitFn = defaultEmit,  // Tests inject spy
): ExtensionFactory { ... }
```

For testing middleware that calls services (e.g., `requireAgent` calls `getPackage`), use **integration tests with real DB** instead of mocking the service layer.

### Test Helpers (`apps/api/test/helpers/`)

| Helper            | Purpose                                                                                                                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`          | `getTestApp()` — full Hono app replica (same middleware chain as production, without boot/Docker/scheduler)                                                                                                                                                          |
| `auth.ts`         | `createTestUser()`, `createTestOrg()`, `createTestContext()`, `authHeaders()`, `orgOnlyHeaders()` — real Better Auth sign-up flow. `TestContext` includes `defaultAppId`. `authHeaders()` auto-injects `X-App-Id`; use `orgOnlyHeaders()` for org-only routes        |
| `db.ts`           | `truncateAll()` — DELETE FROM all 31 tables in FK-safe order                                                                                                                                                                                                         |
| `seed.ts`         | 18+ factories: `seedPackage()`, `seedRun()`, `seedApiKey()`, `seedWebhook()`, `seedApplication()`, `seedConnectionProfile()`, `seedConnectionForApp()`, `seedProviderCredentials()`, etc. — insert real DB records. All app-scoped factories require `applicationId` |
| `assertions.ts`   | `assertDbHas()`, `assertDbMissing()`, `assertDbCount()`, `getDbRow()` — DB state verification                                                                                                                                                                        |
| `redis.ts`        | `getRedis()`, `flushRedis()` — test Redis client                                                                                                                                                                                                                     |
| `sse.ts`          | SSE stream parsing utilities                                                                                                                                                                                                                                         |
| `oauth-server.ts` | Mock OAuth2 provider for connection tests                                                                                                                                                                                                                            |

### Writing New Tests

**Unit test** (no DB, fast):

```typescript
import { describe, it, expect } from "bun:test";
import { myFunction } from "../../src/services/my-service.ts";

describe("myFunction", () => {
  it("does the thing", () => {
    expect(myFunction("input")).toBe("expected");
  });
});
```

**Integration test** (real DB, real HTTP):

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";

const app = getTestApp();

describe("GET /api/my-resource", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "testorg" });
  });

  it("returns 200 with data", async () => {
    const res = await app.request("/api/my-resource", {
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/my-resource");
    expect(res.status).toBe(401);
  });
});
```

## API Reference

**The OpenAPI 3.1 spec is the single source of truth for all API endpoints.** It documents 191 endpoints with full request/response schemas, auth requirements, error codes, and SSE event formats.

- **Source files**: `apps/api/src/openapi/` — modular TypeScript files assembled at build time
- **Live spec**: `GET /api/openapi.json` (raw JSON) — public, no auth
- **Interactive docs**: `GET /api/docs` (Swagger UI) — public, no auth
- **Validation**: `bun run verify:openapi` — structural + lint (0 errors/warnings)

When working on API routes, always consult the corresponding OpenAPI path file in `apps/api/src/openapi/paths/` for the authoritative spec. Route domains: `health`, `auth`, `agents`, `runs`, `realtime`, `schedules`, `connections`, `connection-profiles`, `app-profiles`, `providers`, `provider-keys`, `proxies`, `api-keys`, `packages`, `notifications`, `organizations`, `profile`, `invitations`, `internal`, `welcome`, `meta`, `models`, `applications`, `end-users`, `webhooks`.

## Database

Core schema: `packages/db/src/schema.ts` (Drizzle ORM). Module-owned tables live in `apps/api/src/modules/<name>/schema.ts`. All migrations (core + module) are applied automatically at boot — no manual `db:migrate` step. Use `bun run db:generate` to generate new core migrations after schema changes. No RLS — app-level security by `orgId` (+ `applicationId` for app-scoped resources). Key headless tables: `applications` (app\_ prefix), `endUsers` (eu\_ prefix), `applicationPackages` (installed packages per app with config, model/proxy overrides, version pinning).

## Environment Variables

`getEnv()` from `@appstrate/env` (Zod-validated, cached after first call, fail-fast at startup). Key variables:

| Variable                    | Required | Default                                       | Notes                                                                                                      |
| --------------------------- | -------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `APPSTRATE_MODULES`         | No       | `""`                                          | Comma-separated module specifiers to load at boot. Empty = OSS mode. Cloud: `@appstrate/cloud`             |
| `REDIS_URL`                 | No       | —                                             | Redis connection string. When absent, falls back to in-memory adapters (single-instance only)              |
| `DATABASE_URL`              | No       | —                                             | PostgreSQL connection. When absent, falls back to PGlite (embedded PostgreSQL)                             |
| `BETTER_AUTH_SECRET`        | Yes      | —                                             | Session signing secret                                                                                     |
| `CONNECTION_ENCRYPTION_KEY` | Yes      | —                                             | 32 bytes, base64-encoded. Encrypts stored credentials                                                      |
| `PLATFORM_API_URL`          | No       | —                                             | How sidecar reaches the host platform. Fallback computed at runtime (`http://host.docker.internal:{PORT}`) |
| `SYSTEM_PROXIES`            | No       | `"[]"`                                        | JSON array of system proxy definitions                                                                     |
| `PROXY_URL`                 | No       | —                                             | Outbound HTTP proxy URL injected into sidecar containers                                                   |
| `SYSTEM_PROVIDER_KEYS`      | No       | `"[]"`                                        | JSON array of system provider keys with nested models (credentials + model list per provider)              |
| `LOG_LEVEL`                 | No       | `info`                                        | `debug`\|`info`\|`warn`\|`error`                                                                           |
| `PORT`                      | No       | `3000`                                        | Server port                                                                                                |
| `APP_URL`                   | No       | `http://localhost:3000`                       | Public URL for OAuth callbacks                                                                             |
| `TRUSTED_ORIGINS`           | No       | `http://localhost:3000,http://localhost:5173` | CORS origins, comma-separated                                                                              |
| `DOCKER_SOCKET`             | No       | `/var/run/docker.sock`                        | Path to Docker socket                                                                                      |
| `RUN_ADAPTER`               | No       | `process`                                     | Execution backend: `docker` (containers) or `process` (Bun subprocesses)                                   |
| `SIDECAR_POOL_SIZE`         | No       | `2`                                           | Number of pre-warmed sidecar containers (0 = disabled)                                                     |
| `PI_IMAGE`                  | No       | `appstrate-pi:latest`                         | Docker image for the Pi agent runtime (override for GHCR / custom registries)                              |
| `SIDECAR_IMAGE`             | No       | `appstrate-sidecar:latest`                    | Docker image for the sidecar proxy (override for GHCR / custom registries)                                 |
| `S3_BUCKET`                 | No       | —                                             | S3 bucket name. When absent, falls back to filesystem storage (`FS_STORAGE_PATH`)                          |
| `S3_REGION`                 | No       | —                                             | S3 region (e.g. `us-east-1`). Required when `S3_BUCKET` is set                                             |
| `FS_STORAGE_PATH`           | No       | `./data/storage`                              | Filesystem storage path (used when `S3_BUCKET` is absent)                                                  |
| `PGLITE_DATA_DIR`           | No       | `./data/pglite`                               | PGlite data directory (used when `DATABASE_URL` is absent)                                                 |
| `S3_ENDPOINT`               | No       | —                                             | Custom S3 endpoint (for MinIO/R2/other S3-compatible)                                                      |
| `RUN_TOKEN_SECRET`          | No       | —                                             | Run token signing secret (if unset, tokens are unsigned)                                                   |
| `GOOGLE_CLIENT_ID`          | No       | —                                             | Google OAuth client ID (enables Google sign-in when both Google vars are set)                              |
| `GOOGLE_CLIENT_SECRET`      | No       | —                                             | Google OAuth client secret                                                                                 |
| `GITHUB_CLIENT_ID`          | No       | —                                             | GitHub OAuth App client ID (enables GitHub sign-in when both GitHub vars are set)                          |
| `GITHUB_CLIENT_SECRET`      | No       | —                                             | GitHub OAuth App client secret                                                                             |
| `COOKIE_DOMAIN`             | No       | —                                             | Cookie domain for cross-subdomain auth                                                                     |
| `SMTP_HOST`                 | No       | —                                             | SMTP server host (enables email verification when all SMTP vars are set)                                   |
| `SMTP_PORT`                 | No       | `587`                                         | SMTP server port                                                                                           |
| `SMTP_USER`                 | No       | —                                             | SMTP authentication username                                                                               |
| `SMTP_PASS`                 | No       | —                                             | SMTP authentication password                                                                               |
| `SMTP_FROM`                 | No       | —                                             | Sender email address for verification emails                                                               |

## Agent & Extension Gotchas

- **Reference manifest**: See system package ZIPs in `system-packages/`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: Use top-level `required: ["field1"]` array — NOT `required: true` on individual properties.
- **Schema wrapper convention**: Input/output/config sections use an AFPS wrapper — NOT a raw JSON Schema object. Structure: `{ schema: JSONSchemaObject, fileConstraints?: Record<string, { accept?, maxSize? }>, uiHints?: Record<string, { placeholder? }>, propertyOrder?: string[] }`. The `schema` member MUST be pure JSON Schema 2020-12 (no `placeholder`, `accept`, `maxSize`, `multiple`, `maxFiles`, `propertyOrder` inside). File fields use `{ type: "string", format: "uri", contentMediaType: "..." }` (single) or `{ type: "array", items: { type: "string", format: "uri", contentMediaType: "..." }, maxItems: N }` (multiple) — NEVER `type: "file"`. Detect file fields via `isFileField()` / `isMultipleFileField()` from `@appstrate/core/form`, not inline heuristics.
- **Extension import**: `@mariozechner/pi-coding-agent` (NOT `pi-agent`).
- **Extension `execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** argument. Using `execute(args)` receives the toolCallId string.
- **Extension return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
- **Skills**: YAML frontmatter (`name`, `description`) in `SKILL.md`. Available in container at `.pi/skills/{id}/SKILL.md`.
- **Provider auth modes**: `oauth2` (OAuth2/PKCE with token refresh), `oauth1` (OAuth 1.0a with HMAC-SHA1 — uses `requestTokenUrl`/`accessTokenUrl`; `clientId`/`clientSecret` map to consumer key/secret), `api_key` (single key in header), `basic` (username:password Base64), `custom` (multi-field `credentialSchema` rendered as dynamic form), Sidecar injects credentials via `credentialHeaderName`/`credentialHeaderPrefix`. URI restrictions via `authorizedUris` array or `allowAllUris: true`.
- **Proxy system**: Org-level proxy CRUD via `/api/proxies` (admin-only). System proxies loaded from `SYSTEM_PROXIES` env var at boot. Agent-level override via `GET/PUT /api/agents/:id/proxy`. Cascade: agent override → org default → `PROXY_URL` env var.
- **Application-scoped config**: Agent configuration is per-application via `application_packages` (not per-org). Memories are application-scoped.
- **Run lifecycle**: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`. Status transitions via `updateRunStatus()` in `state.ts`. `pg_notify` fires on every status change, pushing realtime updates to SSE subscribers. Concurrent runs per agent are supported — `run-tracker.ts` tracks all in-flight runs for graceful shutdown.
- **Enriched run responses**: `listRunsWithFilter` and `getRunFull` use LEFT JOINs to enrich runs with `userName` (from `profiles`), `endUserName` (from `end_users`, name with externalId fallback), `apiKeyName` (from `api_keys`), and `scheduleName` (from `package_schedules`). The `EnrichedRun` type in `@appstrate/shared-types` extends `Run` with these four nullable string fields. Frontend components read names directly from the run response — no separate lookup hooks needed.
- **Run trigger tracking**: `runs.apiKeyId` (FK → `api_keys.id`, nullable, ON DELETE SET NULL) records which API key triggered a run. Set from `c.get("apiKeyId")` in the run route. Combined with existing `userId`, `endUserId`, and `scheduleId`, this enables full trigger attribution in the UI.

## Known Issues & Technical Debt

1. **No `stream: false` mode**: The run route always returns SSE. The spec defines a synchronous mode — not yet implemented. `stream?: boolean` in request body is ignored.
2. **Scheduler**: Redis-backed via BullMQ. Distributed exactly-once cron firing, worker rate limiting (max 5/min). Schedules synced from `packageSchedules` table to BullMQ at boot.
3. **Orphan cleanup**: On startup, orphaned runs (still `running`/`pending`) are marked `failed` and all containers labeled `appstrate.managed=true` are cleaned up via `cleanupOrphanedContainers()` in `docker.ts`.
