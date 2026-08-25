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
     |-- PUT .../input-settings ----->|-- schema.ts (AJV) → services/state/ (Drizzle)
     |-- GET /api/integrations/ ----->|-- routes/integrations.ts → OAuth2 flow / API key
     |      connect/start (browser),  |     storage
     |      POST .../connect/submit   |
     |-- POST /api/agents/{scope}/ -->|-- validate → create run → executeAgentInBackground()
     |      {name}/run                |
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

The platform, `PI_IMAGE` and `SIDECAR_IMAGE` are a **version contract**, not three independent knobs: the agent runtime and the sidecar speak a wire protocol to each other, both speak a container boundary to the platform, and all of it changes in the same commit — a trio that disagrees boots fine then fails runs with an opaque upstream error naming none of the three (#1195 for the pair, #1177 for the platform boundary). Two guards, and they are complementary, not redundant. The env schema (`@appstrate/env`, via `findRuntimeImageTagMismatch` from `@appstrate/core/image-ref`) **fails boot** on a disagreement — a cross-field rule like the S3/APP_URL ones, not conditioned on `RUN_ADAPTER`. The two halves are not symmetric: `PI_IMAGE` and `SIDECAR_IMAGE` are always compared to each other literally (every compose file sets both from one `${APPSTRATE_VERSION}`, so any difference is a half-done edit), while the platform joins only when all three values are **release versions**. That predicate is the load-bearing part: the platform's version is `APP_VERSION`, baked into the image by the Dockerfile (`ARG` → `ENV`, fed by the release workflow's tag), i.e. a git ref name, so it can equal an image tag only in the one family (`{{version}}`) the two namespaces share. Comparing it against the other three families `release.yml` publishes for the same image (`latest` — the documented compat fallback —, `{{major}}.{{minor}}`, `sha-<sha>`) or against a non-release build stamp (`dev`, the ARG default and source-run fallback; `health-container-e2e`, what the health e2e job builds with, against `:local` images) does not detect skew, it makes the rule unsatisfiable. Any of those takes the platform out of the trio and the rule degrades to the pair rule, which is what keeps dev boxes, preview deployments, that CI job and `:latest` consumers booting. A digest-pinned ref (either half) is exempt outright. The cost of the predicate, deliberately accepted: both refs floating on `:latest` under a released platform is now accepted, because `APP_VERSION` reads the same whether the platform image was pulled by version tag or by `:latest` — that trio is byte-identical to the supported all-`:latest` deployment, and only the revision guard below can tell them apart. That guard is configuration-only: after the pre-pull, `services/orchestrator/runtime-image-pair.ts` **warns** when the two images on the host carry different `org.opencontainers.image.revision` stamps — _same tag, two builds_ (`:latest` rebuilt on one side only), which tag comparison structurally cannot see. `bun run docker:build:runtime` (alias `build-runtime`) builds BOTH images with the same stamp — there is deliberately no command that rebuilds one half.

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
- **Quality gate**: `bun run check` — 15 task names, not 2: `turbo typecheck lint format:check` plus
  `verify:openapi`, `verify:api-types`, `verify:type-coverage`, `verify:compose-defaults`,
  `detect:breaking`, `build:system-packages:check`, `lint:manifest-casing`, `conformance:check`,
  `verify:module-isolation`, `typecheck:scripts`, `verify:module-contract`, `verify:dead-code`.
  turbo fans those out to **35** actual tasks (`typecheck` alone runs in 21 workspaces) — count them
  with `bunx turbo <the 15 names> --dry=json`, never by reading this line.
  There is no `turbo check` task — the root script drives turbo directly.
- **Dead code**: `verify:dead-code` runs knip over every workspace and fails on an exported symbol
  with no reader, a file nothing reaches, or a declared dependency nothing imports. `eslint`'s
  `no-unused-vars` cannot see any of that — it only sees locals. Config and the reasoning behind
  every entry/ignore: `knip.config.ts`. An entry must say _what reaches the file_; an ignore must
  say _why the finding cannot be acted on_. Public exports of the **published** packages are out of
  scope by design — their readers live out of tree — and exactly two scoped packages here are
  published on an ongoing basis: `@appstrate/core` and `@appstrate/afps-shared`, the only two with
  a publish workflow (`.github/workflows/publish-core.yml`, `publish-afps-shared.yml`).
  `@appstrate/afps-runtime` carries `publishConfig` but is **not** published (no workflow, no tag,
  a `0.0.0` npm placeholder) and stays private by decision; `@appstrate/runner-pi` and the
  `@appstrate/module-*` packages are absent from npm entirely; `@appstrate/ui` is the inverse case
  — `"private": true` here, yet `ui@1.0.0` and `ui@1.0.1` tags exist and 1.0.1 sits on npm, both
  left over from before that flag. There is no `publish-ui.yml`, nothing republishes it, and it is
  treated as private. So a release tag alone proves nothing — the live signal is the workflow, and
  the ground truth is `npm view <pkg> versions`, never the manifest's `publishConfig`. knip derives
  NO entry from a package manifest and a workspace `entry` replaces even its filename defaults, so
  a workspace that declares one must re-declare every `exports`/`bin`/`main` target or its whole
  subtree reads as dead — the cause of a ~161-finding false red fixed on 2026-08-23. That
  re-declaration is now derived by `manifestEntries()` in `knip.config.ts`, so a manifest edit
  cannot silently desynchronise from it; what stays hand-written is the half no manifest implies
  (Docker CMDs, fixtures, operator scripts). Never un-export a symbol to quiet this gate, and add
  an `ignore*` only where knip is structurally blind or the code is vendored in whole, with the
  justification `knip.config.ts` demands at the call site — never to make a finding go away.
  Full detail and the other false green/red signals: `AGENTS.md` → **Quality Gate — and the signals
  it lies with**.
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

Most-touched optional vars: `MODULES` (default `oidc,webhooks,mcp,core-providers,@appstrate/module-chat` — subscription modules `@appstrate/module-codex` + `@appstrate/module-claude-code` are opt-in), `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `RUN_ADAPTER` (default `process`; `docker` for containers), `APP_URL`, `TRUSTED_ORIGINS`, `TRUST_PROXY`. See `docs/ENV.md` for all 115 documented vars with defaults and full notes (97 of them live in the `@appstrate/env` Zod schema; the rest are read directly by modules, the sidecar or the runtime image).

## Agent & Extension Gotchas

- **Reference manifest**: system package ZIPs in `system-packages/`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: top-level `required: ["field1"]` array — NOT `required: true` on properties.
- **Schema wrapper convention**: input/output use an AFPS wrapper — NOT raw JSON Schema. Structure: `{ schema: JSONSchemaObject, file_constraints?, ui_hints?, property_order? }` (snake_case, AFPS §3.4). `schema` member MUST be pure JSON Schema 2020-12. File fields: `{ type: "string", format: "uri", contentMediaType: "..." }` (single) or array of same (multiple) — NEVER `type: "file"`. Detect via `isFileField()` / `isMultipleFileField()` from `@appstrate/core/form`.
- **Extension import**: `@earendil-works/pi-coding-agent` (NOT `pi-agent`).
- **Extension `execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** arg.
- **Extension return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
- **Skills**: YAML frontmatter (`name`, `description`) in `SKILL.md`. Container path `.pi/skills/{id}/SKILL.md`.
- **Proxy system**: org-level CRUD `/api/proxies` (admin). System proxies from `SYSTEM_PROXIES` env at boot. Agent override `GET/PUT /api/agents/:id/proxy`. Cascade: agent → org default → `PROXY_URL`.
- **Application-scoped input defaults**: an agent's stored input values and its per-field locks live together in one jsonb column, `application_packages.input_settings` (`{ values, locked }`), per-application. Its single write path is `PUT /api/agents/{scope}/{name}/input-settings`; on the wire the pair is `{ values, locked_fields }`. `package_persistence` (memory archive + pinned slots) also app-scoped, row-partitioned by `(actor_type, actor_id)` (members + end-users never read each other's state).
- **Run lifecycle**: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`. Transitions via `updateRun()` in `services/state/runs.ts`. `pg_notify` on every change → SSE. Concurrent runs per agent supported (`run-tracker.ts`).
- **Enriched run responses**: `listRunsWithFilter`/`getRunFull` LEFT JOIN to add `user_name`, `end_user_name`, `api_key_name`, `schedule_name`. `EnrichedRun` (`@appstrate/shared-types`) is `RunWireDto` plus these. Frontend reads names directly — no separate lookups.
- **Run trigger tracking**: `runs.apiKeyId` (FK → `api_keys.id`, ON DELETE SET NULL) records triggering key. With `userId`/`endUserId`/`scheduleId` → full trigger attribution.

## Operational Notes & Known Limitations

- **No synchronous run mode** (limitation): the run route is fire-and-forget — returns `202 { runId }`, progress streamed separately via the realtime SSE endpoint. There is no inline-result mode (no `stream` field exists in the body).
- **Scheduler** (operational): Redis/BullMQ, distributed exactly-once, worker rate limiting (max 5/min). Synced from `package_schedules` table at boot.
- **Orphan cleanup** (operational): on startup, orphaned runs (`running`/`pending`) marked `failed`; containers labeled `appstrate.managed=true` cleaned via `cleanupOrphanedContainers()` in `docker.ts`.
