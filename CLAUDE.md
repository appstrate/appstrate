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

Layout is discoverable (`ls`, workspace globs in the root `package.json`). Two things that are not:

- **Workspace imports**: `@appstrate/core/*` (validation, zip, naming, dependencies, integrity, semver, version-policy, system-packages, form, schemas, logger, env, storage, ssrf, dist-tags, module, permissions, runtime-tools-catalog, integration, mcp-server, sidecar-types), `@appstrate/db/schema`, `@appstrate/db/client`, `@appstrate/emails`, `@appstrate/env`, `@appstrate/connect`, `@appstrate/shared-types`. **Core has no barrel** — import each module by subpath.
- **Per-area guides** (loaded only when working there): `apps/api/CLAUDE.md`, `apps/web/CLAUDE.md`, `apps/api/src/modules/README.md` (module authoring).

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

Sidecar + agent setup run in parallel (`Promise.all`). Images pre-pulled at boot (`ensureImage`) and kept warm afterwards by the runtime-image warmer (`services/orchestrator/runtime-image-warmer.ts`: reconciles one `appstrate-imagepin-*` holder container per image, so host-level `docker image prune -a` can't put a cold pull back on the run-boot path). Full sidecar protocol: `docs/architecture/SIDECAR.md`.

**Run liveness is two-phase** (`services/run-watchdog.ts`, same split as Kubernetes `startupProbe` vs `livenessProbe`): until the runner's first event the platform is provisioning and attests liveness on its behalf (`services/run-boot-heartbeat.ts`), bounded by `runs.boot_deadline_at` (`RUN_BOOT_DEADLINE_SECONDS`, default 300s); after it, the runner's own heartbeat owns liveness (`RUN_STALL_THRESHOLD_SECONDS`, default 60s). Each predicate finalises with its own error.

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
- **Built-in dirs** (`apps/api/src/modules/`): `webhooks` (clean `onRunStatusChange` boundary; tables `webhooks`/`webhook_deliveries` in core schema), `oidc` (end-user OAuth 2.1 IdP — reference consumer of `authStrategies()` / `betterAuthPlugins()`; its 10 OAuth/jwks tables live in core schema `schema/oidc.ts`), `core-providers` (openai/anthropic/openai-compatible model providers via `modelProviders()`, owns no tables), `firecracker` (OPT-IN — NOT in the `MODULES` default; contributes a single `firecracker` execution backend via `orchestrators()` — an HTTP client to the `appstrate-runner` host daemon (`bun run firecracker:runner`) which embeds the in-process `FirecrackerOrchestrator` engine; platform reads only `FIRECRACKER_RUNNER_URL`/`_TOKEN`, the host-side `FIRECRACKER_*` vars are daemon-only, no tables/routes; see `docs/architecture/FIRECRACKER.md`). `@appstrate/module-codex` + `@appstrate/module-claude-code` (OPT-IN — NOT in the `MODULES` default; subscription grey-zone — both are agent-run **executable** on the single Pi engine via a provider-neutral sidecar bearer-swap, see `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`) and `@appstrate/module-observability` (OPT-IN — OpenTelemetry provider for the core telemetry façade `@appstrate/core/telemetry`; see `docs/architecture/OBSERVABILITY.md`) are workspace **npm** modules under `packages/module-*`, not built-in dirs.

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
- **Quality gate**: `bun run check` — 14 tasks, not 2: `turbo typecheck lint format:check` plus
  `verify:openapi`, `verify:api-types`, `verify:type-coverage`, `verify:compose-defaults`,
  `detect:breaking`, `build:system-packages:check`, `lint:manifest-casing`, `conformance:check`,
  `verify:module-isolation`, `typecheck:scripts`, `verify:module-contract`. There is no `turbo check`
  task — the root script drives turbo directly.
- **Tests**: `bun test` from root runs all packages in one process. See **Testing** below.

### Frontend

`apps/web` + `packages/ui` conventions (i18n, Tailwind 4, typed API client, React Query keys, SSE hooks, feature gating, Rules-of-React gate): **`apps/web/CLAUDE.md`**, loaded when working there.

### Backend

`apps/api` conventions (multi-tenant filtering, request pipeline, route guards, RBAC, rate limiting, package versioning, Zod/AJV validation, headless platform: applications, end-users, webhooks, idempotency, API versioning, OpenAPI spec): **`apps/api/CLAUDE.md`**, loaded when working there.

### AFPS Integrations (summary)

Outbound third-party API access flows through **integrations** (agent-driven connection model). An integration declares `source.kind: "local"` (sandboxed runner container per integration, `node|python|binary|uv`) or `"remote"` (Streamable HTTP / SSE MCP). Credentials injected sidecar-side (env-delivery or per-run MITM proxy), never read by the integration's MCP server. OAuth scopes inferred per-agent from `tools[]` selection.

Agent manifest splits dependency from config: version on `dependencies.integrations.<id>` (flat semver), tool/scope/auth selection in top-level `integrations_configuration.<id>`. Single read/write path: `parseManifestIntegrations` / `writeManifestIntegrations` (`@appstrate/core/dependencies`).

**Full detail** (runtime spawn, MITM, niveau-2 scope phases, remote HTTP, MCP transport retry): `docs/architecture/INTEGRATIONS_RUNTIME.md`. AFPS wire spec (canonical): <https://github.com/appstrate/afps-spec/blob/main/spec.md>.

## Testing

Full guide (commands and tiers, `bunfig.toml` preload and module auto-discovery, directory layout, conventions table, helpers): skill **`testing`** (`.claude/skills/testing/SKILL.md`).

### Mocking Policy — No `mock.module()`

**Never use `mock.module()`.** It replaces the entire module globally and permanently within a test run, breaking other tests importing the same barrel. (Source of 37 hard-to-diagnose failures.) Use dependency injection instead — see the `testing` skill.

## Database

Core schema: `packages/db/src/schema/` (Drizzle, barrel via `schema.ts`) — includes the tables modules read/write (e.g. `schema/oidc.ts`, `schema/webhooks.ts`). Modules own no separate schema. All migrations applied automatically at boot — no manual `db:migrate`. `bun run db:generate` for new migrations. No RLS — app-level security by `orgId` (+ `applicationId`). Key headless tables: `applications` (`app_`), `endUsers` (`eu_`), `applicationPackages`.

## Environment Variables

`getEnv()` from `@appstrate/env` (Zod-validated, cached, fail-fast at boot) is authoritative. **Full table: `docs/ENV.md`.**

Required vars (boot fails without them):

| Variable                    | Notes                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`        | Session signing secret                                                          |
| `CONNECTION_ENCRYPTION_KEY` | 32 bytes base64. Primary key for new credential ciphertexts (v1 envelope)       |
| `UPLOAD_SIGNING_SECRET`     | HMAC secret for FS upload-sink tokens (≥16 chars), rotates independently        |
| `RUN_TOKEN_SECRET`          | HMAC secret for run bearer tokens (≥16 chars), rotates independently            |
| `CONNECT_SESSION_SECRET`    | HMAC secret for hosted-connect-portal tokens (≥16 chars), rotates independently |

Most-touched optional vars: `MODULES` (default `oidc,webhooks,mcp,core-providers,@appstrate/module-chat` — subscription modules `@appstrate/module-codex` + `@appstrate/module-claude-code` are opt-in), `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `RUN_ADAPTER` (default `process`; `docker` for containers), `APP_URL`, `TRUSTED_ORIGINS`, `TRUST_PROXY`. See `docs/ENV.md` for all ~75 vars with defaults and full notes.

## Agent & Extension Gotchas

- **Reference manifest**: system package ZIPs in `system-packages/`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: top-level `required: ["field1"]` array — NOT `required: true` on properties.
- **Schema wrapper convention**: input/output/config use an AFPS wrapper — NOT raw JSON Schema. Structure: `{ schema: JSONSchemaObject, file_constraints?, ui_hints?, property_order? }` (snake_case, AFPS §3.4). `schema` member MUST be pure JSON Schema 2020-12. File fields: `{ type: "string", format: "uri", contentMediaType: "..." }` (single) or array of same (multiple) — NEVER `type: "file"`. Detect via `isFileField()` / `isMultipleFileField()` from `@appstrate/core/form`.
- **Extension import**: `@earendil-works/pi-coding-agent` (NOT `pi-agent`).
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
