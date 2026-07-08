# Appstrate — Developer Guide

Appstrate is an open-source platform for running autonomous AI agents in sandboxed Docker containers. A user signs up, connects OAuth/API key services (Gmail, ClickUp), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Agents can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

> **Deep references** (read on demand, not loaded every session):
>
> - Env vars → `docs/ENV.md` (authoritative: `@appstrate/env` Zod schema)
> - AFPS integration model → `docs/architecture/INTEGRATIONS_RUNTIME.md`
> - Sidecar protocol → `docs/architecture/SIDECAR.md`
> - Run cost tracking → `docs/architecture/RUN_COST.md`
> - Observability (OpenTelemetry) → `docs/architecture/OBSERVABILITY.md`
> - Casing policy → `docs/CASING_CONVENTIONS.md`
> - Module authoring → `apps/api/src/modules/README.md`

## Quick Start

> **Self-hosting (production)?** Use the one-liner installer: `curl -fsSL https://get.appstrate.dev | bash`. See `examples/self-hosting/README.md`. The instructions below are for **development**.

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

| Constraint     | Details                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime        | **Bun** everywhere — NOT node. Bun auto-loads `.env`                                                                                                                                                                                                                                                               |
| API framework  | **Hono** — NOT `Bun.serve()` (need SSE via `streamSSE`, routing, middleware)                                                                                                                                                                                                                                       |
| Docker client  | **`fetch()` + unix socket** — NOT dockerode (socket bugs with Bun). See `services/docker.ts`                                                                                                                                                                                                                       |
| DB security    | **No RLS** — app-level security, all queries filter by `orgId` (+ `applicationId` for app-scoped resources)                                                                                                                                                                                                        |
| Logging        | **`lib/logger.ts`** (JSON to stdout) — no `console.*` calls                                                                                                                                                                                                                                                        |
| Auth           | **Better Auth** cookie sessions + `X-Org-Id` + `X-Application-Id` headers. Email/password + optional Google/GitHub social (opt-in via env). Optional email verification (opt-in via SMTP env). API key (`ask_` prefix) tried first, then cookie. `Appstrate-User` header for end-user impersonation (API key only) |
| Validation     | **Zod 4** for all request body/query validation + JSONB safe narrowing. **AJV** only for dynamic manifest schemas                                                                                                                                                                                                  |
| Env validation | **`@appstrate/env`** (Zod schema) is the single source of truth — not `.env.example`. Full table: `docs/ENV.md`                                                                                                                                                                                                    |
| Redis          | **Redis 7+** — BullMQ scheduler, distributed rate limiting (`rate-limiter-flexible`), cancel Pub/Sub, OAuth PKCE state                                                                                                                                                                                             |
| Storage        | **S3** (`@aws-sdk/client-s3`) via `@appstrate/core/storage-s3` — configurable endpoint for MinIO/R2                                                                                                                                                                                                                |

## Navigating the Codebase

```
appstrate/
├── apps/api/src/             # @appstrate/api — Hono backend (:3000)
│   ├── index.ts              # Entry: middleware, auth, startup init, SPA config injection
│   ├── lib/boot.ts           # Boot sequence (loadModules → system init → scheduler)
│   ├── lib/modules/          # Module loader, registry, migration helpers
│   ├── modules/              # Built-in modules (webhooks, oidc, …) — schema, routes, migrations
│   ├── routes/               # Core route handlers (one file per domain)
│   ├── services/             # Business logic, Docker, adapters, scheduler
│   ├── openapi/              # OpenAPI 3.1 spec (source of truth for endpoints) — paths/ per domain
│   └── types/                # Backend types + re-exports from shared-types
│
├── apps/web/src/             # @appstrate/web — React 19 + Vite + React Query v5
│   ├── pages/ hooks/ components/ stores/ lib/
│   ├── styles.css            # Tailwind 4 (dark theme, @theme inline)
│   └── i18n.ts               # i18next: fr (default) + en; ns: common/agents/settings
│
├── packages/db/src/          # @appstrate/db — Drizzle ORM + Better Auth
│   ├── schema.ts             # Full schema (barrel re-export from schema/)
│   ├── client.ts             # db + listenClient (LISTEN/NOTIFY)
│   └── auth.ts               # Better Auth config
│
├── packages/emails/src/      # @appstrate/emails — template registry + rendering (cloud override)
├── packages/core/            # @appstrate/core — shared validation, storage, utilities (published on npm)
├── packages/ui/              # @appstrate/ui — React components (private workspace pkg, consumed by web)
├── packages/afps-runtime/    # @appstrate/afps-runtime — portable AFPS bundle runner + standalone `afps` CLI
├── packages/mcp-transport/   # @appstrate/mcp-transport — MCP SDK adapter (sidecar + runtime-pi)
├── packages/env/src/         # @appstrate/env — Zod env validation (authoritative)
├── packages/shared-types/    # @appstrate/shared-types — Drizzle InferSelectModel re-exports
├── packages/connect/         # @appstrate/connect — OAuth2/PKCE, API key, credential encryption
├── apps/cli/                 # @appstrate/cli — channel-aware install, self-update, doctor
├── system-packages/          # System package ZIPs (skills, mcp-servers, integrations, agents — loaded at boot)
├── runtime-pi/               # Docker image: Pi Coding Agent SDK + entrypoint
│   ├── entrypoint.ts         # SDK session → HMAC-signed CloudEvents → POST /api/runs/:runId/events
│   ├── sidecar/              # Credential-isolating MCP server + integrations boot (see docs/architecture/SIDECAR.md)
│   └── runners/{node,python,binary}/  # Per-language MCP runner images
└── scripts/verify-openapi.ts # bun run verify:openapi
```

**Workspace imports**: `@appstrate/core/*` (validation, zip, naming, dependencies, integrity, semver, version-policy, system-packages, form, schemas, logger, env, storage, ssrf, dist-tags, module, permissions, runtime-tools-catalog, integration, mcp-server, sidecar-types), `@appstrate/db/schema`, `@appstrate/db/client`, `@appstrate/emails`, `@appstrate/env`, `@appstrate/connect`, `@appstrate/shared-types`. Core has no barrel — import each module by subpath.

## Architecture

```
User Browser (BrowserRouter SPA)  Platform (Bun + Hono :3000)
     |                                |
     |-- Login/Signup --------------->|-- Better Auth (cookie session)
     |-- / (Agent List) ------------->|-- GET /api/agents
     |-- PUT /api/agents/:id/config ->|-- schema.ts (AJV) → state.ts (Drizzle)
     |-- POST .../connect/:prov ----->|-- connect route → OAuth2 flow / API key storage
     |-- POST /api/agents/:id/run --->|-- validate → create run → executeAgentInBackground()
     |<-- SSE (replay + live) --------|-- subscribe to logs via pub/sub
     |   Realtime (LISTEN/NOTIFY) ----|-- pg_notify on runs + run_logs → patches React Query cache
     |   Scheduler (BullMQ + Redis) --|-- distributed cron, exactly-once, same execute path
     |                                |
     |   Docker network: appstrate-exec-{runId} (isolated bridge)
     |   ┌─ Sidecar Container (alias "sidecar") ──────────────┐
     |   │  RUN_TOKEN, PLATFORM_API_URL via env               │
     |   │  /mcp (JSON-RPC stateless): run_history,           │
     |   │    recall_memory, {ns}__api_call (cred injection), │
     |   │    {ns}__{tool} (spawned integrations — one runner │
     |   │    container per integration)                      │
     |   ├─ Agent Container (Pi Coding Agent, Bun) ───────────┤
     |   │  AGENT_PROMPT, LLM_*; SIDECAR_URL deleted after    │
     |   │  bootstrap; NO RUN_TOKEN; cannot reach host        │
     |   └────────────────────────────────────────────────────┘
```

Sidecar + agent setup run in parallel (`Promise.all`). Images pre-pulled at boot (`ensureImage`) to amortise cold pull. Full sidecar protocol: `docs/architecture/SIDECAR.md`.

## Key Conventions & Gotchas

### Casing conventions (snake_case wire / camelCase TS internal)

Authoritative reference: **`docs/CASING_CONVENTIONS.md`**. TL;DR:

- **Wire JSON** (HTTP, AFPS manifests, OpenAPI, OAuth2 fields, SQL columns) → **snake_case**
- **Drizzle TS schema fields** → **camelCase** TS / **snake_case** SQL alias (`userId: text("user_id")`)
- **TS internal** (args, vars, React props, Zustand state) → **camelCase**
- **Universal DB-convention fields** (`id`, `*Id`, `createdAt`, `updatedAt`, `expiresAt`, `runNumber`, …) → **camelCase EVERYWHERE** (Drizzle, wire, OpenAPI, frontend)
- **Better Auth tables** → camelCase TS (HARD framework blocker)
- **Module hooks, logger fields, CloudEvents, webhook deliveries, BullMQ jobs, audit-log `after` payloads** → camelCase

When in doubt: wire = snake_case, internal = camelCase. Audit: `/audit-casing` (6 parallel agents, 100% compliance check).

**Package IDs in URL paths**: two shapes by rule — single package → `{scope}/{name}`, route referencing ≥2 packages → `{packageId}` (e.g. `/api/integrations/*`). Both resolve to the same `@scope/name` wire path. Always encode with `encodePackageIdPath` from `@appstrate/core/naming` — never `encodeURIComponent` on the whole id (it 404s the route regexes). Full rule: `docs/CASING_CONVENTIONS.md` → "Package identifiers in URL paths".

### Module System

Formalized system for optional features. Contract in `@appstrate/core/module` (published on npm) so external modules implement without depending on the API package. **Authoring guide + full lifecycle/permissions/hooks detail: `apps/api/src/modules/README.md`.**

Essentials:

- **Discovery**: loader resolves each `MODULES` specifier against `apps/api/src/modules/<id>/index.ts` first, then npm import. No registration table — drop a directory + add id to `MODULES`.
- **Lifecycle**: core migrations (incl. all module tables) → discover built-ins → topological sort by `manifest.dependencies` → aggregate permissions → `init()` (workers only — no migrations) → `createRouter()` → running → `shutdown()`. All declared modules required; any failure is fatal.
- **Modules own no tables** (core 2.23.0+): a module is pure behavior. All OSS tables — including those a module reads/writes — live in the **core schema** (`packages/db/src/schema/`) and are created by the system migration pipeline at boot. No module `schema.ts` / `drizzle/migrations/` / `__drizzle_migrations_<id>`, no `drizzleSchemas()` / `ctx.applyMigrations` (removed). A module imports its tables from `@appstrate/db/schema`; Better Auth resolves them from the core barrel directly. Cross-module data access goes via API/events, never a SQL join. A separate-tenant module (`@appstrate/cloud`) runs its **own DB** + migrations and reads platform data through `ctx.services` (e.g. `services.runs.listLlmUsage`).
- **Built-in dirs** (`apps/api/src/modules/`): `webhooks` (clean `onRunStatusChange` boundary; tables `webhooks`/`webhook_deliveries` in core schema), `oidc` (end-user OAuth 2.1 IdP — reference consumer of `authStrategies()` / `betterAuthPlugins()`; its 10 OAuth/jwks tables live in core schema `schema/oidc.ts`), `core-providers` (openai/anthropic/openai-compatible model providers via `modelProviders()`, owns no tables), `firecracker` (OPT-IN — NOT in the `MODULES` default; contributes a single `firecracker` execution backend via `orchestrators()` — an HTTP client to the `appstrate-runner` host daemon (`bun run firecracker:runner`) which embeds the in-process `FirecrackerOrchestrator` engine; platform reads only `FIRECRACKER_RUNNER_URL`/`_TOKEN`, the host-side `FIRECRACKER_*` vars are daemon-only, no tables/routes; see `docs/architecture/FIRECRACKER.md`). `@appstrate/module-codex` + `@appstrate/module-claude-code` (OPT-IN — NOT in the `MODULES` default; subscription grey-zone, see `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`) and `@appstrate/module-observability` (OPT-IN — OpenTelemetry provider for the core telemetry façade `@appstrate/core/telemetry`; see `docs/architecture/OBSERVABILITY.md`) are workspace **npm** modules under `packages/module-*`, not built-in dirs.

- **Hooks vs Events**: Hooks (`callHook`) — `beforeRun`/`afterRun` are first-match-wins gates/patches; `beforeSignup`/`afterSignup` are broadcast to all. Events (`emitEvent`) broadcast, side-effect only (`onRunStatusChange`/`onOrgCreate`/`onOrgDelete`), errors isolated. Platform calls by name, never by module ID.
- **Permissions**: RBAC co-owned by core + modules. Core catalog in `@appstrate/core/permissions`; role-grant matrix in `apps/api/src/lib/permissions.ts`. Modules extend via declaration merging on `AppstrateModuleResources` + `permissionsContribution()`. All three guards (`requirePermission`, `requireCorePermission`, `requireModulePermission`) delegate to `makePermissionGuard` in core.
- **Disabling = zero footprint**: remove from `MODULES` → not imported/initialized; no tables/routes/middleware/flags/RBAC. Scheduling + provider management deliberately live in **core** (coupling with `runs` made module isolation cost more than it delivered).

### Progressive Infrastructure

Tiered model — every external dependency is optional with a built-in fallback. Adapters in `apps/api/src/infra/` with dynamic imports.

| Component                     | When absent                     | Fallback                       | Tier |
| ----------------------------- | ------------------------------- | ------------------------------ | ---- |
| PostgreSQL (`DATABASE_URL`)   | PGlite (embedded WASM Postgres) | `./data/pglite/`               | 1+   |
| Redis (`REDIS_URL`)           | In-memory adapters              | EventEmitter, Map, local queue | 2+   |
| S3/MinIO (`S3_BUCKET`)        | Filesystem storage              | `./data/storage/`              | 3    |
| Docker (`RUN_ADAPTER=docker`) | Bun subprocesses                | No container isolation         | 3    |

Tier 0 (zero-install) requires only Bun.

### Development Workflow

- **New API route**: route file in `routes/` + OpenAPI path file in `openapi/paths/` + wire in `index.ts`. Run `bun run verify:openapi`, then `bun run generate:api` to refresh the SPA's generated types (`verify:api-types` in `check` fails otherwise). Every 2xx JSON response must declare a schema (verify-openapi step 6).
- **DB migration (core)**: edit `packages/db/src/schema.ts` → `bun run db:generate` (needs `DATABASE_URL` for drizzle-kit). Applied automatically at boot (PGlite + PostgreSQL) — no manual `db:migrate`.
- **Module tables**: there are none separately — a module's tables live in the core schema (`packages/db/src/schema/<domain>.ts`) and migrate with core. No per-module migration step.
- **Quality gate**: `bun run check` (turbo check = tsc across packages + `verify-openapi`).
- **Tests**: `bun test` from root runs all packages in one process. See **Testing** below.

### Frontend

- **i18n**: `i18next` + `react-i18next`. Default `fr`, supported `fr`/`en`. Namespaces `common`/`agents`/`settings`. Locales in `apps/web/src/locales/{lang}/`.
- **Styling**: Tailwind 4 (`@tailwindcss/vite` + `tailwind-merge`). Single `styles.css`, `@import "tailwindcss"` + custom `@theme inline` dark theme. Utility classes only.
- **Auth**: Better Auth React client. `credentials: "include"` + `X-Org-Id`/`X-Application-Id` injected by the typed client's middleware (`api/client.ts`) from `org-store`/`app-store`.
- **Realtime**: SSE hooks (`use-realtime.ts`) + `useGlobalRunSync` patches React Query cache directly for `run_update` AND `connection_update` events (the latter drives live `Reconnection required` badge updates across tabs). `useGlobalRunSync` uses `fetch()` + `ReadableStream` (NOT `EventSource`) to avoid Safari auto-reconnect — **do not convert**. `GlobalRealtimeSync` mounted inside `MainLayout` only (not onboarding/welcome). SSE channels emitted: `run_update`, `run_log`, `run_metric`, `connection_update` — actor-scoped server-side via subscriber filter on `userId`/`endUserId`.
- **Feature gating**: `useAppConfig()` reads `window.__APP_CONFIG__` (injected at serve time, computed once by `buildAppConfig()`). Core keys (`googleAuth`, `githubAuth`, `smtp`) statically typed; module keys flow through `[key: string]: boolean`. No API call. Module features default `false` when absent. Sidebar/routes/tabs fully gated.
- **Typed API client** (`api/client.ts`) — REQUIRED for new code: `$api.useQuery("get", "/api/end-users", { params })` / `$api.useMutation(...)` (openapi-react-query) and raw `client.GET(...)` (openapi-fetch), typed against `api/schema.d.ts` generated from the OpenAPI spec (`bun run generate:api`; `verify:api-types` in `check` fails when stale). Middleware injects org/app headers + throws `ApiError` (RFC 9457) on non-2xx — direct `client.X()` calls must try/catch, the `{ error }` branch is never populated. Query keys are `[method, path, init]`: pass the spec-declared `X-Org-Id`/`X-Application-Id` header params explicitly in queries so scope is part of the key; after writes invalidate each path string separately (list and `/{id}` differ). The legacy fetch barrel (`api.ts`) is deleted; an ESLint guard (`eslint.config.mjs`) bans its old import specifiers. Path params keep `@` (and the `/` inside `@scope/name` package ids) literal via the client's `pathSerializer` — Hono regex routes match the raw path. Specifics: list envelopes unwrap via `select: (e) => e.data`; multipart goes through `bodySerializer: () => formData` (never set `Content-Type`); blobs via `parseAs: "blob"`; the SchemaForm uploader lives in `api/uploads.ts`; the only sanctioned untyped call site is `cloudApi` in `use-billing.ts` (cloud-module routes are absent from the OSS spec by design).
- **React Query keys**: typed-client hooks use `[method, path, init]` (scope rides in init). Run/schedule/package caches keep PINNED legacy keys (`["run", id]`, `["runs", …]`, `["paginated-runs", …]`, `["packages", …]`, `["agents", …]`, `["agent-model"/"agent-proxy", …]`) because `use-global-run-sync` (SSE) and app-switch resets patch/invalidate them by those names — don't re-key without updating the patchers. On org switch, `queryClient.removeQueries` wipes all except `["orgs"]`.
- **Standard components**: `<Modal>` for dialogs (never raw overlays); `<LoadingState>`/`<ErrorState>`/`<EmptyState>` from `page-states.tsx`; `<SchemaForm>` (from `@appstrate/ui/schema-form`) for JSON-Schema forms — file fields are handled inside it via the `uploadClient` upload fn (`api/uploads.ts`), not a separate component.
- **Rules of React (static gate)**: `apps/web` + `packages/ui` lint with `eslint-plugin-react-hooks` **`recommended-latest`** (`eslint.config.mjs`) — layers the React Compiler static rules (`purity`, `set-state-in-render`/`set-state-in-effect`, `immutability`, `refs`, `static-components`, `preserve-manual-memoization`, …) on top of the core hooks rules. These catch the Rules-of-React violations that cause unnecessary re-renders and fragile components. Enforced in `bun run check` (local + CI lint step) — a static cleanliness/robustness gate, no runtime/Playwright harness. A violation fails the build; fix the component (don't disable the rule).

### Backend

- **Multi-tenant**: all DB queries filter by `orgId`. App-scoped resources (agents, runs, schedules, webhooks, connections, end-users, api-keys, notifications, packages) also filter by `applicationId`. Admins = org role `admin`/`owner`.
- **Service layer**: function-based (no classes). `services/state/` (runs, notifications, package-persistence) is the central data-access layer. Drizzle via `import { db } from "@appstrate/db/client"` + schema from `@appstrate/db/schema`.
- **Request pipeline** (`index.ts`): error handler → Request-Id → client-IP (`TRUST_PROXY`) → CORS → bodyLimit → health (`/`) → OpenAPI docs → `/llms.txt` → shutdown gate → `/api/auth/bootstrap` → Better Auth (`/api/auth/*`) → auth middleware (custom strategies → API key `ask_` → cookie → `Appstrate-User`) → **realm guard** (`requirePlatformRealm` — rejects OIDC end-user sessions on platform routes) → org context (`X-Org-Id`) → permission resolution → app context (`X-Application-Id`, required for app-scoped routes) → API version (`Appstrate-Version`) → route handler (per-route `rateLimit()`/`idempotency()`) → cloud routes (if loaded).
- **Platform config**: `buildAppConfig()` computed once at boot, serialized as `window.__APP_CONFIG__`, injected into `index.html` at serve time. `googleAuth`/`githubAuth`/`smtp` derived from env presence.
- **External modules**: appended npm specifiers to `MODULES`. Declared-but-not-installed = boot crash.
- **Cost tracking**: `runs.cost` (doublePrecision) = sum of `llm_usage` ledger via `computeRunCost(runId)` (single read path). Ingestion paths + precision trade-off: `docs/architecture/RUN_COST.md`.
- **Hono context** (`c.get`): `user`, `orgId`, `orgRole`, `orgSlug`, `permissions`, `authMethod`, `apiKeyId`, `applicationId`, `app`, `endUser`, `apiVersion`, `package` (set by `requireAgent` — NOT `agent`), `run`, `requestId`, `sessionRealm`.
- **Route guards** (`middleware/guards.ts`): `requireAgent()` (no arg — reads `:scope`/`:name`, loads package, sets `c.set("package")`), `requireOrgAgent()`, `requirePackageInOrg()` (gates package mutation on DB `orgId` ownership — NOT scope identity; a foreign-scope package the org owns is freely mutable), `requireMutableAgent()` (403 system package, 409 running runs), `apiKeyOrgScopeGuard()`/`apiKeyAppScopeGuard()` (stop an API key escaping its org/app via path params). RBAC is `requirePermission(resource, action)` (`middleware/require-permission.ts`) — there is **no** `requireAdmin()`/`requireOwner()`. `requireAppContext()` (`middleware/app-context.ts`) validates `X-Application-Id` (or API-key's `applicationId`) + app∈org.
- **Rate limiting**: Redis-backed `rate-limiter-flexible`. Keyed `method:path:identity` (`userId` / `apikey:{id}`), IP-based for public routes. IETF `RateLimit` headers. Key limits: run 20/min, import 10/min, schedule-create 10/min, run logs 120/min.
- **Route registration order**: `userAgentsRouter` MUST register before `agentsRouter` in `index.ts` — Hono matches in order.
- **Docker streams**: multiplexed 8-byte frame headers `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`.
- **Package versioning**: semver across `package-versions.ts`, `package-version-deps.ts`, `package-storage.ts`. Tables: `packageVersions`, `packageDistTags`, `packageVersionDependencies`. Enforcement via `@appstrate/core/version-policy` (`validateForwardVersion` — forward-only). Resolution: exact → dist-tag → semver range (`resolveVersionFromCatalog`). Integrity: SHA256 SRI via `@appstrate/core/integrity`.
- **Package types**: `agent`, `skill`, `mcp-server`, `integration`. System tools (`output`/`log`/`note`/`pin`/`report`) are transport-neutral MCP definitions in `packages/core/src/runtime-tool-defs.ts` (served sidecar-side), opt-in per agent via manifest `runtime_tools: string[]` (catalog `@appstrate/core/runtime-tools-catalog`). `output` required only when agent declares `output.schema` (enforced by `agentManifestSchema` superRefine). Outbound third-party API access flows exclusively through **integrations**.
- **System agents**: all agents (system + local) live in DB. System agents loaded from `system-packages/` ZIPs at boot and synced with `orgId: null` (`lib/boot.ts` `syncSystemPackagesToDb()`).
- **Graceful shutdown**: `run-tracker.ts` — stop scheduler → reject new POST → wait in-flight (max 30s) → exit.
- **Validation (Zod)**: all route bodies validated with `parseBody(schema, body)` from `lib/errors.ts` (`.safeParse()` → throws `invalidRequest()`). Naming `{concept}Schema` / `{Concept}` (`z.infer`). JSONB reads use safe narrowing (null/typeof/Array.isArray), not raw `as`. Query params: `z.coerce.number().int().min().max().catch(default).parse()`. **Zod 4** — `z.url()` NOT `z.string().url()`, `z.uuid()`. Reference: `routes/models.ts`, `routes/webhooks.ts`, `routes/organizations.ts`.
- **Validation (AJV)**: `validateConfig()`/`validateInput()`/`validateOutput()` for **dynamic** manifest schemas only. One AJV instance, `coerceTypes: true`, extra fields allowed.

### Headless Developer Platform

Headless API for embedding agents. Patterns mirror Stripe.

- **Applications** (`applications`, prefix `app_`): each org has a default (`isDefault: true`). API keys scoped to an application. Routes `/api/applications` (CRUD, admin).
- **End-users** (`end_users`, prefix `eu_`): external users via API, belong to an application. Not Better Auth users. Routes `/api/end-users` (CRUD, admin). Fields: `externalId` (unique/app), `metadata` (JSONB ≤50 keys), `email`, `name`. Default connection profile on creation.
- **`Appstrate-User` header**: impersonation (`eu_` ID). API key auth only — `400` on cookie. Validates end-user belongs to key's application. Full audit log per impersonation.
- **Webhooks** (`webhooks` prefix `wh_`, `webhook_deliveries`): application-scoped (`applicationId` NOT NULL). Standard Webhooks spec (HMAC-SHA256). BullMQ delivery, 8-attempt backoff. Events: `run.started`/`success`/`failed`/`timeout`/`cancelled`. SSRF protection on URLs. Routes `/api/webhooks` (CRUD + test/ping + rotate + deliveries, admin).
- **Application packages** (`application_packages`): installed packages per app with config/model/proxy overrides + version pinning. Agent config is per-application (not per-org).
- **API versioning**: date-based. Header `Appstrate-Version` (request override + response). Org pinning via `settings.apiVersion`. `Sunset` header on deprecated. `middleware/api-version.ts`.
- **Idempotency**: `Idempotency-Key` on POST routes. Redis-backed, 24h TTL, SHA-256 body hash. `409` concurrent, `422` body mismatch, `Idempotent-Replayed: true` on cached replay. `middleware/idempotency.ts`.
- **Error handling**: RFC 9457 `application/problem+json` on all endpoints. `ApiError` factories (`invalidRequest`, `unauthorized`, `forbidden`, `notFound`, `conflict`, `gone`, `internalError`, `systemEntityForbidden`). `Request-Id` (`req_`) on all responses.
- **SSE + API key**: SSE endpoints accept `?token=ask_...` query param (EventSource can't send headers). Cookie fallback preserved.

### AFPS Integrations (summary)

Outbound third-party API access flows through **integrations** (agent-driven connection model). An integration declares `source.kind: "local"` (sandboxed runner container per integration, `node|python|binary|uv`) or `"remote"` (Streamable HTTP / SSE MCP). Credentials injected sidecar-side (env-delivery or per-run MITM proxy), never read by the integration's MCP server. OAuth scopes inferred per-agent from `tools[]` selection.

Agent manifest splits dependency from config: version on `dependencies.integrations.<id>` (flat semver), tool/scope/auth selection in top-level `integrations_configuration.<id>`. Single read/write path: `parseManifestIntegrations` / `writeManifestIntegrations` (`@appstrate/core/dependencies`).

**Full detail** (runtime spawn, MITM, niveau-2 scope phases, remote HTTP, MCP transport retry): `docs/architecture/INTEGRATIONS_RUNTIME.md`. AFPS wire spec (canonical): <https://github.com/appstrate/afps-spec/blob/main/spec.md>.

## Testing

```sh
bun test                          # Full suite — core + every module, single process
bun test apps/api/test            # Core only
bun test apps/api/src/modules     # All modules
bun run test:unit                 # API unit tests only (no DB)
bun run test:e2e                  # Playwright e2e suite
bun run test:docker               # Include slow Docker-engine (DinD) tests (TEST_DOCKER=1)
cd apps/api/src/modules/webhooks && bun test   # Per-module (own bunfig.toml)
bun test path/to/file.test.ts     # Single file
bun test -t "substring"           # Filter by test name
```

Requires Docker (PostgreSQL :5433, Redis :6380, MinIO :9012, DinD :2375 — started automatically by preload). DinD-dependent tests skip by default locally — opt in with `TEST_DOCKER=1` (or `bun run test:docker`); they always run when `CI=true` (GitHub Actions). Third-party CI that sets `CI=1` must set `TEST_DOCKER=1` explicitly (the tier helper warns). The Tier-0 path (`TEST_TIER=0`, `bun run test:tier0`) runs against PGlite with no Docker.

### Configuration

Single root `bunfig.toml` drives core tests; each module has its own pointing at the same root preload. Root preload (`test/setup/preload.ts`) runs Docker Compose, sets env, applies core migrations, then auto-discovers built-in modules (`apps/api/src/modules/*/`) **and** workspace modules (`packages/module-*/src/`) and wires:

- `drizzle/migrations/*.sql` → applied alphabetically via `apply-module-migration.ts`
- `index.ts` → dynamic-imported, registered in `test-modules.ts` for `getTestApp()`
- `test/tables.ts` → `string[]` registered via `registerTruncationTables()`

Adding a built-in module is mechanical: drop directory with `index.ts`, `drizzle/migrations/`, `test/tables.ts`. No edits to core test infra.

### Structure

```
apps/api/test/
├── unit/                  # Pure logic, no DB
├── integration/{middleware,routes,services}/
└── helpers/               # app, auth, db, seed, assertions, sse, redis, oauth-server, openapi-validator

apps/api/src/modules/<name>/        # bunfig.toml (module root) + test/{helpers,unit,integration,tables.ts}
apps/web/src/**/test/               # Frontend unit (colocated)
runtime-pi/test/ + runtime-pi/sidecar/test/
packages/core/test/ + packages/connect/test/
```

**Zero-footprint invariant**: core tests have zero knowledge of any module. `getTestApp()` takes optional `{ modules }` — core calls with none, module helpers pass their own. Cross-module behavior covered by e2e, not by loading multiple modules in one process.

### Conventions

| Convention    | Rule                                                                |
| ------------- | ------------------------------------------------------------------- |
| Framework     | `bun:test` — NOT vitest/jest                                        |
| Test function | `it()` — NOT `test()`                                               |
| Import        | `import { describe, it, expect, beforeEach, mock } from "bun:test"` |
| File naming   | `*.test.ts` — NOT `*.spec.ts`                                       |
| Isolation     | `beforeEach(async () => { await truncateAll(); })` for DB tests     |
| App testing   | `app.request()` via Hono — NOT `Bun.serve()`, no port binding       |
| Auth in tests | Real Better Auth sign-up → session cookie (not mock auth)           |
| DB cleanup    | `DELETE FROM` in FK-safe order (not `TRUNCATE` — avoids deadlocks)  |

### Mocking Policy — No `mock.module()`

**Never use `mock.module()`.** It replaces the entire module globally and permanently within a test run, breaking other tests importing the same barrel. (Source of 37 hard-to-diagnose failures.)

Use dependency injection: optional `deps` parameter with production defaults, constructor injection, or function-parameter injection (runtime-pi pattern). For middleware that calls services (e.g. `requireAgent` → `getPackage`), use integration tests with real DB instead of mocking the service layer.

### Helpers (`apps/api/test/helpers/`)

| Helper            | Purpose                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`          | `getTestApp()` — full Hono replica (production middleware chain, no boot/Docker/scheduler)                                                                      |
| `auth.ts`         | `createTestUser/Org/Context()`, `authHeaders()`, `orgOnlyHeaders()` — real Better Auth sign-up. `authHeaders()` auto-injects `X-Application-Id`                 |
| `db.ts`           | `truncateAll()` — DELETE FROM all tables in FK-safe order                                                                                                       |
| `seed.ts`         | Factories: `seedPackage()`, `seedInstalledPackage()`, `seedRun()`, `seedApiKey()`, `seedApplication()`, `seedEndUser()`, … (app-scoped require `applicationId`) |
| `assertions.ts`   | `assertDbHas/Missing/Count()`, `getDbRow()`                                                                                                                     |
| `redis.ts`        | `getRedis()`, `flushRedis()`                                                                                                                                    |
| `sse.ts`          | SSE stream parsing                                                                                                                                              |
| `oauth-server.ts` | Mock OAuth2 provider                                                                                                                                            |

To write a new test, copy the nearest existing one in the matching directory (unit = pure, integration = `getTestApp()` + `truncateAll()` + `createTestContext()`).

## API Reference

**OpenAPI 3.1 spec is the single source of truth for all API endpoints** (request/response schemas, auth, errors, SSE formats).

- **Source**: `apps/api/src/openapi/` — modular TS files assembled at build time. Module endpoints contribute via `AppstrateModule.openApiPaths()`.
- **Live spec**: `GET /api/openapi.json` (public). **Docs**: `GET /api/docs` (Swagger UI, public).
- **Validation**: `bun run verify:openapi` — coverage, structural, lint, Zod↔spec bodies, Code ⊆ Spec static analysis (ADR-004).

When working on routes, consult the corresponding `apps/api/src/openapi/paths/` file. Domains: health, auth, agents, runs, realtime, schedules, integrations, proxies, api-keys, packages, library, uploads, me, notifications, organizations, profile, invitations, internal, welcome, meta, models, model-provider-credentials, model-providers-oauth, applications, end-users, webhooks, credential-proxy, llm-proxy + OIDC module's oauth-clients & cli-sessions.

## Database

Core schema: `packages/db/src/schema/` (Drizzle, barrel via `schema.ts`) — includes the tables modules read/write (e.g. `schema/oidc.ts`, `schema/webhooks.ts`). Modules own no separate schema. All migrations applied automatically at boot — no manual `db:migrate`. `bun run db:generate` for new migrations. No RLS — app-level security by `orgId` (+ `applicationId`). Key headless tables: `applications` (`app_`), `endUsers` (`eu_`), `applicationPackages`.

## Environment Variables

`getEnv()` from `@appstrate/env` (Zod-validated, cached, fail-fast at boot) is authoritative. **Full table: `docs/ENV.md`.**

Required vars (boot fails without them):

| Variable                    | Notes                                                                     |
| --------------------------- | ------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`        | Session signing secret                                                    |
| `CONNECTION_ENCRYPTION_KEY` | 32 bytes base64. Primary key for new credential ciphertexts (v1 envelope) |
| `UPLOAD_SIGNING_SECRET`     | HMAC secret for FS upload-sink tokens (≥16 chars), rotates independently  |

Most-touched optional vars: `MODULES` (default `oidc,webhooks,mcp,core-providers,@appstrate/module-chat` — subscription modules `@appstrate/module-codex` + `@appstrate/module-claude-code` are opt-in), `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `RUN_ADAPTER` (default `process`; `docker` for containers), `APP_URL`, `TRUSTED_ORIGINS`, `TRUST_PROXY`. See `docs/ENV.md` for all ~75 vars with defaults and full notes.

## Agent & Extension Gotchas

- **Reference manifest**: system package ZIPs in `system-packages/`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: top-level `required: ["field1"]` array — NOT `required: true` on properties.
- **Schema wrapper convention**: input/output/config use an AFPS wrapper — NOT raw JSON Schema. Structure: `{ schema: JSONSchemaObject, file_constraints?, ui_hints?, property_order? }` (snake_case, AFPS §3.4). `schema` member MUST be pure JSON Schema 2020-12. File fields: `{ type: "string", format: "uri", contentMediaType: "..." }` (single) or array of same (multiple) — NEVER `type: "file"`. Detect via `isFileField()` / `isMultipleFileField()` from `@appstrate/core/form`.
- **Extension import**: `@mariozechner/pi-coding-agent` (NOT `pi-agent`).
- **Extension `execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** arg.
- **Extension return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
- **Skills**: YAML frontmatter (`name`, `description`) in `SKILL.md`. Container path `.pi/skills/{id}/SKILL.md`.
- **Proxy system**: org-level CRUD `/api/proxies` (admin). System proxies from `SYSTEM_PROXIES` env at boot. Agent override `GET/PUT /api/agents/:id/proxy`. Cascade: agent → org default → `PROXY_URL`.
- **Application-scoped config**: agent config per-application via `application_packages`. `package_persistence` (memory archive + pinned slots) also app-scoped, row-partitioned by `(actor_type, actor_id)` (members + end-users never read each other's state).
- **Run lifecycle**: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`. Transitions via `updateRun()` in `services/state/runs.ts`. `pg_notify` on every change → SSE. Concurrent runs per agent supported (`run-tracker.ts`).
- **Enriched run responses**: `listRunsWithFilter`/`getRunFull` LEFT JOIN to add `user_name`, `end_user_name`, `api_key_name`, `schedule_name`. `EnrichedRun` (`@appstrate/shared-types`) extends `Run` with these. Frontend reads names directly — no separate lookups.
- **Run trigger tracking**: `runs.apiKeyId` (FK → `api_keys.id`, ON DELETE SET NULL) records triggering key. With `userId`/`endUserId`/`scheduleId` → full trigger attribution.

## Operational Notes & Known Limitations

- **No synchronous run mode** (limitation): the run route is fire-and-forget — returns `202 { runId }`, progress streamed separately via the realtime SSE endpoint. There is no inline-result mode (no `stream` field exists in the body).
- **Scheduler** (operational): Redis/BullMQ, distributed exactly-once, worker rate limiting (max 5/min). Synced from `package_schedules` table at boot.
- **Orphan cleanup** (operational): on startup, orphaned runs (`running`/`pending`) marked `failed`; containers labeled `appstrate.managed=true` cleaned via `cleanupOrphanedContainers()` in `docker.ts`.
