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
bun run dev                   # turbo dev → Hono on :3000

# 7. First signup creates an organization automatically
```

## Stack — Critical Constraints

| Constraint     | Details                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **Bun** everywhere — NOT node. Bun auto-loads `.env`                                                                |
| API framework  | **Hono** — NOT `Bun.serve()` (need SSE via `streamSSE`, routing, middleware)                                        |
| Docker client  | **`fetch()` + unix socket** — NOT dockerode (socket bugs with Bun). See `services/docker.ts`                        |
| DB security    | **No RLS** — app-level security, all queries filter by `orgId`                                                      |
| Logging        | **`lib/logger.ts`** (JSON to stdout) — no `console.*` calls                                                         |
| Auth           | **Better Auth** cookie sessions + `X-Org-Id` header. API key auth (`ask_` prefix) tried first, then cookie fallback |
| Env validation | **`@appstrate/env`** (Zod schema) is the single source of truth — not `.env.example`                                |

## Navigating the Codebase

```
appstrate/
├── apps/api/src/             # @appstrate/api — Hono backend (:3000)
│   ├── index.ts              # Entry: middleware, auth, startup init
│   ├── routes/               # Route handlers (one file per domain)
│   ├── services/             # Business logic, Docker, adapters, scheduler
│   ├── openapi/              # OpenAPI 3.1 spec (source of truth for all endpoints)
│   │   └── paths/            # One file per route domain (138 endpoints)
│   └── types/                # Backend types + re-exports from shared-types
│
├── apps/web/src/             # @appstrate/web — React 19 + Vite + React Query v5
│   ├── pages/                # Route pages (React Router v7 BrowserRouter)
│   ├── hooks/                # React Query hooks + SSE realtime hooks
│   ├── components/           # UI components (modals, forms, editors)
│   ├── stores/               # Zustand stores (auth-store, org-store, profile-store)
│   ├── lib/                  # Utilities (auth-client, markdown, provider-status, strings)
│   ├── styles.css            # Single CSS file (dark theme, no Tailwind/modules)
│   └── i18n.ts               # i18next: fr (default) + en, namespaces: common/flows/settings
│
├── packages/db/src/          # @appstrate/db — Drizzle ORM + Better Auth
│   ├── schema.ts             # Full schema (26 tables, 6 enums, indexes)
│   ├── client.ts             # db + listenClient (LISTEN/NOTIFY)
│   └── auth.ts               # Better Auth config (auto profile+org on signup)
│
├── packages/env/src/         # @appstrate/env — Zod env validation (authoritative)
├── packages/shared-types/    # @appstrate/shared-types — Drizzle InferSelectModel re-exports
├── packages/connect/         # @appstrate/connect — OAuth2/PKCE, API key, credential encryption
├── packages/registry-client/ # @appstrate/registry-client — HTTP client for Appstrate [registry]
│
├── system-packages/           # System package ZIPs (providers, skills, extensions, flows — loaded at boot)
│
├── runtime-pi/               # Docker image: Pi Coding Agent SDK
│   ├── entrypoint.ts         # SDK session → JSON lines on stdout
│   └── sidecar/server.ts     # Credential-isolating HTTP proxy (Hono)
│
└── scripts/verify-openapi.ts # bun run verify:openapi
```

**Workspace imports**: `@appstrate/db/schema`, `@appstrate/db/client`, `@appstrate/env`, `@appstrate/connect`, `@appstrate/shared-types`, `@appstrate/registry-client`. **External npm dep**: `@appstrate/core` (shared with registry — validation, zip, naming, dependencies, integrity, semver, registry-deps, update-check, publish-manifest).

## Architecture

```
User Browser (BrowserRouter SPA)  Platform (Bun + Hono :3000)
     |                                |
     |-- Login/Signup --------------->|-- Better Auth (email/password → cookie session)
     |                                |
     |-- / (Flow List) -------------->|-- GET /api/flows (with runningExecutions count)
     |-- /flows/:id (Flow Detail) --->|-- GET /api/flows/:id (with services, config, state, skills)
     |-- PUT /api/flows/:id/config -->|-- schema.ts (AJV validation) → state.ts (Drizzle)
     |-- POST /auth/connect/:prov --->|-- connection-manager.ts → OAuth2 flow / API key storage
     |                                |
     |-- POST /api/flows/:id/run ---->|
     |                                |-- 1. Validate deps, config, input (AJV)
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
     |            Sidecar Pool (pre-warmed):  |-- initSidecarPool() at startup
     |            - 2 standby containers on   |-- acquireSidecar() → /configure → attach
     |              appstrate-sidecar-pool net |-- replenish in background after acquire
     |                                        |-- shutdownSidecarPool() on exit
     |                                |
     |            Docker network: appstrate-exec-{execId} (isolated bridge)
     |            Sidecar + Agent setup run in parallel (Promise.all)
     |            ┌─────────────────────────────────────────────┐
     |            │  Sidecar Container (alias: "sidecar")       │
     |            │  - EXECUTION_TOKEN, PLATFORM_API_URL        │
     |            │  - Configured via env vars (fresh) or       │
     |            │    POST /configure (pooled pre-warmed)      │
     |            │  - Proxies /proxy → credential injection    │
     |            │  - Proxies /execution-history               │
     |            │  - ExtraHosts → host.docker.internal        │
     |            ├─────────────────────────────────────────────┤
     |            │  Agent Container (Pi Coding Agent, Bun)     │
     |            │  - FLOW_PROMPT, LLM_*, SIDECAR_URL          │
     |            │  - NO EXECUTION_TOKEN, NO PLATFORM_API_URL  │
     |            │  - NO ExtraHosts (cannot reach host)        │
     |            │  - Files injected before start (parallel)   │
     |            │  - Calls sidecar via curl for API access    │
     |            │  - Outputs JSON lines on stdout             │
     |            └─────────────────────────────────────────────┘
```

## Key Conventions & Gotchas

### Development Workflow

- **New API route**: Create route file in `routes/` + OpenAPI path file in `openapi/paths/` + wire in `index.ts`. Run `bun run verify:openapi` to validate.
- **DB migration**: Edit `packages/db/src/schema.ts` → `bun run db:generate` → `bun run db:migrate`.
- **Quality gate**: `bun run check` (turbo check = TypeScript across all packages + `verify-openapi` structural/lint validation).
- **Tests**: `bun test` in `apps/api/`. Framework: `bun:test` (NOT vitest/jest). Tests in `services/__tests__/` and `routes/__tests__/`. Mocking pattern: call `mock.module("../../services/foo.ts", () => ({ fn: mock(...) }))` BEFORE `const { handler } = await import("../route.ts")` — dynamic import is required so mocks take effect. No frontend tests currently.

### Frontend

- **i18n**: `i18next` with `react-i18next`. Default: `fr`, supported: `fr`/`en`. Namespaces: `common`, `flows`, `settings`. Locales in `apps/web/src/locales/{lang}/`.
- **Styling**: Single `styles.css` (dark theme). No CSS modules, no Tailwind, no CSS-in-JS.
- **Auth**: Better Auth React client → `credentials: "include"` on all `apiFetch()` calls. `X-Org-Id` header for org context.
- **Realtime**: SSE EventSource hooks (`use-realtime.ts`) + `useGlobalExecutionSync` patches React Query cache directly. `useGlobalExecutionSync` deliberately uses `fetch()` + `ReadableStream` (NOT `EventSource`) to avoid Safari aggressive auto-reconnect — do not convert it.
- **API helpers** (`api.ts`): `api<T>(path)` prepends `/api` + JSON parse; `apiFetch<T>(path)` raw path (for `/auth/*`); `uploadFormData<T>(path, formData)` for file uploads — never set `Content-Type` manually (browser sets multipart boundary); `apiBlob(path)` for binary downloads. All inject `X-Org-Id` and `credentials: "include"`.
- **React Query keys**: Always org-scoped `[entity, orgId, id?]` — e.g. `["flows", orgId]`, `["flow", orgId, packageId]`, `["executions", orgId, packageId]`. Only exception: `["orgs"]` is global. On org switch, `queryClient.removeQueries` wipes all except `["orgs"]`.
- **Standard components**: Always use `<Modal>` (`components/modal.tsx`) for dialogs — never build raw overlays. Use `<LoadingState>`, `<ErrorState>`, `<EmptyState>` from `page-states.tsx` for page states. Use `<InputFields>` for JSON Schema-driven forms, `<FileField>` for uploads.

### Backend

- **Multi-tenant**: All DB queries filter by `orgId`. Admins = org role `admin` or `owner`.
- **Service layer**: All function-based (no classes). `state.ts` is the central data-access layer (executions, logs, config, admin connections). Drizzle ORM with `import { db } from "../lib/db.ts"` and schema from `@appstrate/db/schema`.
- **Request pipeline**: CORS → health check (`/`) → OpenAPI docs → shutdown gate → Better Auth (`/api/auth/*`) → auth middleware (API key `ask_` first, then cookie) → org context middleware (`X-Org-Id` → verify membership) → route handler.
- **Hono context** (`c.get(...)`): `user` (id, email, name), `orgId`, `orgRole` ("owner"/"admin"/"member"), `authMethod` ("session"/"api_key"), `apiKeyId`, `flow` (set by `requireFlow()`).
- **Route guards** (`middleware/guards.ts`): `requireAdmin()` → 403 if not admin/owner; `requireFlow(param)` → loads flow + sets `c.set("flow")`, 404 if missing; `requireMutableFlow()` → also checks not system package + no running executions.
- **Rate limiting**: Token bucket per `method:path:identity` where identity is `userId` for sessions or `apikey:{apiKeyId}` for API keys. IP-based (`ip:method:path:ip`) for public unauthenticated routes. Key limits: run (20/min), import (10/min), create (10/min).
- **Route registration order**: `userFlowsRouter` MUST be registered before `flowsRouter` in `index.ts` — Hono matches in order.
- **Docker streams**: Multiplexed 8-byte frame headers `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`.
- **Marketplace**: `marketplace.ts` + `registry-provider.ts` — searches/installs packages from external Appstrate [registry]. `installFromMarketplace()` uses a 3-phase pattern: `collectPackages()` (network + DB reads, no writes) → `commitPackages()` (single DB transaction with `pg_advisory_xact_lock` per package) → post-install (storage/versions). Auto-installs missing `registryDependencies` recursively (marked `autoInstalled: true`), with circular-dependency protection via `visited` set and diamond dedup via `collected` array. Max 10 packages per install (root + deps). Auto-installed packages are hidden from library listings but protected from deletion while depended upon (`DEPENDED_ON` 409 error). Packages installed from the marketplace are stored with `source: "local"` — the registry is a distribution channel, not a permanent status. Provenance is traceable via `packageVersions` entries (integrity, manifest snapshot). Uses `@appstrate/core/dependencies` for extraction and `@appstrate/core/naming` for packageId conversion.
- **Package versioning**: Semver-based version system across `package-versions.ts`, `package-version-deps.ts`, and `package-storage.ts`. Key tables: `packageVersions` (version, integrity, manifest snapshot, yanked), `packageDistTags` (named pointers like "latest"), `packageVersionDependencies` (per-version skill/extension deps). Semver enforcement via `@appstrate/core/version-policy` (`validateForwardVersion` — forward-only, no downgrades). "latest" dist-tag auto-managed on non-prerelease publishes. Custom dist-tags via `addDistTag`/`removeDistTag` (protected: "latest" cannot be set/removed manually). Yank support via `yankVersion` (sets `yanked: true`, reassigns affected dist-tags to best stable version). 3-step version resolution: exact match → dist-tag lookup → semver range (`resolveVersionFromCatalog`). Integrity: SHA256 SRI hash computed via `@appstrate/core/integrity`. Per-version dependencies stored via `storeVersionDependencies` (extracted with `@appstrate/core/dependencies`). Migration path: migration 0011 adds schema columns, seed script backfills existing packages, migration 0012 finalizes.
- **Providers as packages**: Providers (OAuth/API services) are the 4th package type (`type: "provider"`) alongside flows, skills, and extensions. Provider definition lives in `packages.manifest.definition` (JSONB). System providers loaded from ZIP files in `system-packages/` at boot via `system-packages.ts`. Credentials stored in `providerCredentials` table keyed by `(providerId, orgId)`. Routes in `routes/providers.ts` (GET list, POST create, PUT update, DELETE). OAuth/credential logic in `@appstrate/connect` (`packages/connect/src/registry.ts`).
- **FlowService**: All flows (system + local) stored in DB. System flows loaded from ZIPs at boot and synced to DB with `orgId: null`.
- **Graceful shutdown**: `execution-tracker.ts` — stop scheduler + sidecar pool → reject new POST → wait in-flight (max 30s) → exit.
- **Validation (AJV)**: `validateConfig()`, `validateInput()`, and `validateOutput()` all share one AJV instance with `coerceTypes: true` (e.g. `"50"` accepted as number). Extra fields always allowed (no `additionalProperties: false`).

### Sidecar Protocol (details beyond the architecture diagram)

- **Sidecar pool**: `sidecar-pool.ts` pre-warms 2 sidecar containers at startup on a standby network. `acquireSidecar()` configures a pooled container via `POST /configure` (sets `executionToken`, `platformApiUrl`, `proxyUrl`), then connects it to the execution network. Falls back to fresh creation if pool is empty or configuration fails. Pool replenishes in background after each acquisition.
- **Parallel startup**: `pi.ts` runs sidecar setup (pool acquire or fresh create) in parallel with agent container creation + file injection via `Promise.all`. Files are batch-injected as a single tar archive before `startContainer()`.
- Agent calls `$SIDECAR_URL/proxy` with `X-Provider`, `X-Target`, optional `X-Proxy`, and optional `X-Substitute-Body` headers for authenticated API requests.
- Sidecar substitutes `{{variable}}` placeholders in headers/URL/proxy (and request body if `X-Substitute-Body: true`), validates against `authorizedUris` per provider.
- **Proxy cascade**: Outbound requests route through proxies in priority order: `X-Proxy` header (agent-driven) → `PROXY_URL` env var (infrastructure). Flow-level and org-level proxy config is resolved by the platform before container creation.
- **Transparent pass-through**: Sidecar forwards upstream responses as-is (HTTP status code + body + Content-Type). Truncation (>50KB) signaled via `X-Truncated: true` header. Sidecar-specific errors (credential fetch, URL validation) return JSON `{ error }` with 4xx/5xx status.
- **Prompt building**: `buildEnrichedPrompt()` generates sections (User Input, Configuration, Previous State, Execution History API) + appends raw `prompt.md`. No Handlebars.
- **Output validation**: If `output.schema` exists, AJV validates the result. On mismatch, `buildRetryPrompt()` re-executes up to `execution.outputRetries` times. Final failure = accepted with warning.
- **State persistence**: `result.state` → persisted to execution record. Only latest state injected as `## Previous State` next run. Historical executions available via `$SIDECAR_URL/execution-history`.

## API Reference

**The OpenAPI 3.1 spec is the single source of truth for all API endpoints.** It documents 138 endpoints with full request/response schemas, auth requirements, error codes, and SSE event formats.

- **Source files**: `apps/api/src/openapi/` — modular TypeScript files assembled at build time
- **Live spec**: `GET /api/openapi.json` (raw JSON) — public, no auth
- **Interactive docs**: `GET /api/docs` (Swagger UI) — public, no auth
- **Validation**: `bun run verify:openapi` — structural + lint (0 errors/warnings)

When working on API routes, always consult the corresponding OpenAPI path file in `apps/api/src/openapi/paths/` for the authoritative spec. Route domains: `health`, `auth`, `flows`, `executions`, `realtime`, `schedules`, `connections`, `connection-profiles`, `providers`, `proxies`, `api-keys`, `marketplace`, `packages`, `notifications`, `organizations`, `profile`, `invitations`, `share`, `internal`, `welcome`, `meta`.

## Database

Full schema: `packages/db/src/schema.ts` (26 tables + 6 enums, Drizzle ORM). Migrations: `bun run db:generate` + `bun run db:migrate`. No RLS — app-level security by `orgId`.

## Environment Variables

`getEnv()` from `@appstrate/env` (Zod-validated, cached after first call, fail-fast at startup). Key variables:

| Variable                    | Required | Default                                       | Notes                                                                                                      |
| --------------------------- | -------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Yes      | —                                             | PostgreSQL connection string                                                                               |
| `BETTER_AUTH_SECRET`        | Yes      | —                                             | Session signing secret                                                                                     |
| `CONNECTION_ENCRYPTION_KEY` | Yes      | —                                             | 32 bytes, base64-encoded. Encrypts stored credentials                                                      |
| `PLATFORM_API_URL`          | No       | —                                             | How sidecar reaches the host platform. Fallback computed at runtime (`http://host.docker.internal:{PORT}`) |
| `SYSTEM_PROXIES`            | No       | `"[]"`                                        | JSON array of system proxy definitions                                                                     |
| `PROXY_URL`                 | No       | —                                             | Outbound HTTP proxy URL injected into sidecar containers                                                   |
| `SYSTEM_MODELS`             | No       | `"[]"`                                        | JSON array of system LLM model definitions (same pattern as `SYSTEM_PROXIES`)                              |
| `LOG_LEVEL`                 | No       | `info`                                        | `debug`\|`info`\|`warn`\|`error`                                                                           |
| `PORT`                      | No       | `3000`                                        | Server port                                                                                                |
| `APP_URL`                   | No       | `http://localhost:3000`                       | Public URL for OAuth callbacks                                                                             |
| `TRUSTED_ORIGINS`           | No       | `http://localhost:3000,http://localhost:5173` | CORS origins, comma-separated                                                                              |
| `DOCKER_SOCKET`             | No       | `/var/run/docker.sock`                        | Path to Docker socket                                                                                      |
| `EXECUTION_ADAPTER`         | No       | `pi`                                          | Adapter type for flow execution                                                                            |
| `OAUTH_CALLBACK_URL`        | No       | —                                             | Custom OAuth callback URL (computed from `APP_URL` if unset)                                               |
| `STORAGE_DIR`               | No       | `""`                                          | Directory for file storage                                                                                 |

## Flow & Extension Gotchas

- **Reference manifest**: See system package ZIPs in `system-packages/`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: Use top-level `required: ["field1"]` array — NOT `required: true` on individual properties.
- **Extension import**: `@mariozechner/pi-coding-agent` (NOT `pi-agent`).
- **Extension `execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** argument. Using `execute(args)` receives the toolCallId string.
- **Extension return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
- **Skills**: YAML frontmatter (`name`, `description`) in `SKILL.md`. Available in container at `.pi/skills/{id}/SKILL.md`.
- **Provider auth modes**: `oauth2` (OAuth2/PKCE with token refresh), `oauth1` (OAuth 1.0a with HMAC-SHA1 — uses `requestTokenUrl`/`accessTokenUrl`; `clientId`/`clientSecret` map to consumer key/secret), `api_key` (single key in header), `basic` (username:password Base64), `custom` (multi-field `credentialSchema` rendered as dynamic form), `proxy` (outbound HTTP proxy — auto-sets `allowAllUris: true` and `credentialSchema` with URL field). Sidecar injects credentials via `credentialHeaderName`/`credentialHeaderPrefix`. URI restrictions via `authorizedUris` array or `allowAllUris: true`.
- **Proxy system**: Org-level proxy CRUD via `/api/proxies` (admin-only). System proxies loaded from `SYSTEM_PROXIES` env var at boot. Flow-level override via `GET/PUT /api/flows/:id/proxy`. Cascade: flow override → org default → `PROXY_URL` env var.
- **Execution lifecycle**: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`. Status transitions via `updateExecutionStatus()` in `state.ts`. `pg_notify` fires on every status change, pushing realtime updates to SSE subscribers. Concurrent executions per flow are supported — `execution-tracker.ts` tracks all in-flight executions for graceful shutdown.

## Known Issues & Technical Debt

1. **No `stream: false` mode**: The execution route always returns SSE. The spec defines a synchronous mode — not yet implemented. `stream?: boolean` in request body is ignored.
2. **Scheduler is in-memory**: Cron jobs run in-process via `croner`, re-loaded from DB on restart. Distributed locking via `schedule_runs` table prevents duplicates.
3. **Orphan cleanup**: On startup, orphaned executions (still `running`/`pending`) are marked `failed` and all containers labeled `appstrate.managed=true` are cleaned up via `cleanupOrphanedContainers()` in `docker.ts`.
