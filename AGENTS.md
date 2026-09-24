# Appstrate — Developer Guide

Appstrate is an open-source platform for running autonomous AI agents in sandboxed Docker containers. A user signs up, connects OAuth/API key services (Gmail, ClickUp), clicks "Run", and the AI agent processes their data autonomously inside a temporary container. Agents can also be scheduled via cron, imported from ZIP files, and extended with agent skills.

This is the single instruction file for this directory: every coding agent reads it, whichever filename it looks for. `CLAUDE.md` next to it is a one-line `@AGENTS.md` import and holds no content of its own — never add a rule there. Same rule in `apps/api`, `apps/web` and `apps/cli` — though `apps/cli/AGENTS.md` is a different kind of document: an operating manual for an agent driving a live instance, not conventions for changing the code there.

> **Deep references** (read on demand, not loaded every session):
>
> - Env vars → `docs/ENV.md` (authoritative: `@appstrate/env` Zod schema)
> - AFPS integration model → `docs/architecture/INTEGRATIONS_RUNTIME.md`
> - Sidecar protocol → `docs/architecture/SIDECAR.md`
> - Run cost tracking → `docs/architecture/RUN_COST.md`
> - Observability (OpenTelemetry) → `docs/architecture/OBSERVABILITY.md`
> - Casing policy → `docs/CASING_CONVENTIONS.md`
> - Quality-gate forensics (the knip false red, in full) → `docs/QUALITY_GATE.md`
> - Test tiers, preload, conventions and DB isolation (full guide) → `.claude/skills/testing/SKILL.md`
> - Per-area guides (and which is not one) → § "Per-area guides" below

## Quick Start

> **Self-hosting (production)?** Use the one-liner installer: `curl -fsSL https://get.appstrate.dev | bash`. See `examples/self-hosting/README.md`. The instructions below are for **development**.

**Tier 0 (zero-install — recommended for development):**

```sh
bun install
cp .env.example .env
bun run dev                   # PGlite + filesystem + in-memory → :3000
```

No Docker, no PostgreSQL, no Redis. After signup, the onboarding flow guides the user to create their first organization.

**Tier 3 (full stack with Docker):**

```sh
bun run setup                 # Interactive tier selection, starts Docker, migrates DB, builds
bun run dev
```

### Commands

| Command                  | Description                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install`            | Install dependencies (use `--frozen-lockfile` in CI)                                                                                        |
| `bun run dev`            | Start API (:3000) + Vite build --watch (turborepo)                                                                                          |
| `bun test`               | Run all tests (bun:test). Docker-dependent tests skip unless `TEST_DOCKER=1` — always on in CI                                              |
| `bun run check`          | The quality gate — 21 task names in one turbo invocation. The list, and the steps that lie: § "Quality Gate — and the signals it lies with" |
| `bun run build`          | Build everything (turbo build)                                                                                                              |
| `bun run db:generate`    | Generate Drizzle migrations from schema changes                                                                                             |
| `bun run db:migrate`     | Apply migrations manually (rarely needed — boot migrates on start)                                                                          |
| `bun run verify:openapi` | Validate OpenAPI spec (structural + lint, 0 errors required)                                                                                |

### Docker Compose (Tier 1-3)

Every service in `docker-compose.dev.yml` sits behind a `profiles:` gate, so `docker compose -f docker-compose.dev.yml up -d` starts **nothing**. Use the tier scripts below, or pass the profile yourself (`minimal` | `standard` | `full`).

- **`docker-compose.dev.yml`** — Development services with profiles:
  - `bun run docker:dev:minimal` — Tier 1: PostgreSQL only
  - `bun run docker:dev:standard` — Tier 2: PostgreSQL + Redis
  - `bun run docker:dev` — Tier 3: PostgreSQL + Redis + MinIO
- **`docker-compose.yml`** — Self-hosting / production (images from GHCR)
- **`docker:prod`** script — `docker compose --profile prod up -d` (full stack)
- **`deploy/docker-compose.yml`** — the deployment that runs `app.appstrate.com`, driven by Coolify. NOT a template and not merged with `examples/self-hosting/`: its service names are wired to live domains, so renaming one deletes the routing. It requires `MODULES` (`${MODULES:?}`), which must name `@appstrate/module-ee`. Moved here from the retired `appstrate/cloud` repository; see `deploy/README.md`.

## Stack — Critical Constraints

| Constraint     | Details                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime        | **Bun** everywhere — NOT node. Bun auto-loads `.env`                                                                                                                                                                                                                                                          |
| API framework  | **Hono** — NOT `Bun.serve()` (need SSE via `streamSSE`, routing, middleware)                                                                                                                                                                                                                                  |
| Docker client  | **`fetch()` + unix socket** — NOT dockerode (socket bugs with Bun). See `services/docker.ts`                                                                                                                                                                                                                  |
| Database       | **PostgreSQL 16** + Drizzle ORM (postgres.js). PGlite (embedded WASM Postgres) when `DATABASE_URL` is absent                                                                                                                                                                                                  |
| DB security    | **No RLS** — app-level security, all queries filter by `orgId` (+ `spaceId` for space-scoped resources)                                                                                                                                                                                                       |
| Logging        | **`@appstrate/core/logger`** (pino JSON to stdout) — no `console.*` calls; `apps/api` builds its instance from it in `lib/logger.ts` — import that one there                                                                                                                                                  |
| Auth           | **Better Auth** cookie sessions + `X-Org-Id` + `X-Space-Id` headers. Email/password + optional Google/GitHub social (opt-in via env). Optional email verification (opt-in via SMTP env). API key (`apst_` prefix) tried first, then cookie. `Appstrate-User` header for end-user impersonation (API key only) |
| Validation     | **Zod 4** for all request body/query validation + JSONB safe narrowing. **AJV** only for dynamic manifest schemas                                                                                                                                                                                             |
| Env validation | **`@appstrate/env`** (Zod schema) is the single source of truth — not `.env.example`. Full table: `docs/ENV.md`                                                                                                                                                                                               |
| Redis          | **Redis 7+** — BullMQ scheduler, distributed rate limiting (`rate-limiter-flexible`), cancel Pub/Sub, OAuth PKCE state                                                                                                                                                                                        |
| Storage        | **S3** (`@aws-sdk/client-s3`) via `@appstrate/core/storage-s3` — configurable endpoint for MinIO/R2                                                                                                                                                                                                           |
| Frontend       | **React 19** + Vite + React Router v7 + React Query v5 + Zustand                                                                                                                                                                                                                                              |
| Styling        | **Tailwind CSS 4** (`@tailwindcss/vite`, dark theme)                                                                                                                                                                                                                                                          |
| Build          | **Turborepo** + Bun workspaces. Backend has no build step — Bun resolves `.ts` directly                                                                                                                                                                                                                       |

## Code Conventions

- **TypeScript strict mode**
- **No Node APIs** -- use Bun equivalents (`Bun.CryptoHasher`, `Bun.file`, etc.)
- **French UI text** via i18next (`fr` default, `en`), English code/comments
- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **Zod 4**, never Zod 3: `z.url()`, not `z.string().url()`
- **bun:test** with `it()` -- NOT `test()`, NOT vitest/jest
- **File naming**: `*.test.ts` -- NOT `*.spec.ts`

## Navigating the Codebase

Layout is discoverable (`ls`, workspace globs in the root `package.json`). What is not discoverable — the tree's intent, the import surface, and which guide owns which area — is below.

### Monorepo Structure (Turborepo + Bun workspaces)

```
appstrate/
├── apps/
│   ├── api/src/              # Hono API server (:3000)
│   │   ├── routes/           # Route handlers (one file per domain)
│   │   ├── services/         # Business logic, Docker, adapters, scheduler
│   │   ├── modules/          # Built-in modules -- routes + RBAC, NO owned schemas; modules/README.md owns the list
│   │   ├── openapi/          # OpenAPI 3.1 spec (source of truth for every endpoint)
│   │   └── middleware/       # Auth, rate-limit, guards
│   ├── cli/                  # `appstrate` on npm (unscoped) -- channel-aware install + self-update + doctor
│   └── web/src/              # React 19 SPA (Vite + React Query v5 + Zustand)
│       ├── pages/            # Route pages (React Router v7)
│       ├── hooks/            # React Query + SSE realtime hooks
│       ├── components/       # UI components
│       └── stores/           # Zustand stores (auth, org, profile)
├── packages/
│   ├── core/                 # @appstrate/core -- shared validation, storage, utilities (published on npm)
│   ├── afps-shared/          # @appstrate/afps-shared -- zero-internal-dep leaf: bundle/SSRF/credential helpers (published on npm; must be released BEFORE any core release that bumps its range)
│   ├── ui/                   # @appstrate/ui -- React design system (shadcn components, schema-form, widgets) -- private workspace pkg, consumed by apps/web AND packages/module-chat
│   ├── afps-runtime/         # @appstrate/afps-runtime -- portable AFPS bundle runner + signing + conformance + `afps` CLI
│   ├── runner-pi/            # @appstrate/runner-pi -- Pi run driver + container-env builder (SIDECAR_OPERATOR_ENV_KEYS lives here)
│   ├── mcp-transport/        # @appstrate/mcp-transport -- MCP SDK adapter consumed by sidecar + runtime-pi
│   ├── db/                   # @appstrate/db -- Drizzle ORM + Better Auth (ALL tables, incl. the ones modules read/write)
│   ├── env/                  # @appstrate/env -- Zod env validation (authoritative source)
│   ├── emails/               # @appstrate/emails -- Email templates + rendering
│   ├── shared-types/         # @appstrate/shared-types -- Drizzle InferSelectModel re-exports
│   ├── module-*/             # @appstrate/module-{chat,claude-code,codex,ee,observability} -- workspace modules; only module-chat is in the MODULES default
│   └── connect/              # @appstrate/connect -- OAuth2/PKCE, API key, credential encryption (v1 envelope + multi-key keyring)
├── runtime-pi/               # Docker image: Pi Coding Agent SDK + sidecar (MCP server) + per-runtime MCP runner images
└── system-packages/          # System package `.afps` archives -- integrations + one mcp-server (`ls system-packages/` for today's set)
```

### Workspace Imports

Import from workspace packages using their published subpaths. **Core has no barrel** — import each module by subpath.

- `@appstrate/core/*` — validation, zip, naming, dependencies, integrity, semver, version-policy, system-packages, form, schemas, logger, env, storage, ssrf, dist-tags, module, permissions, runtime-tools-catalog, integration, mcp-server, sidecar-types
- `@appstrate/db/schema` -- Drizzle schema. **Every** table lives here, including the ones a module reads/writes (`schema/oidc.ts`, `schema/webhooks.ts`, …). Modules own no schema, no migrations, no `schema.ts` of their own
- `@appstrate/db/client` -- `db` + `listenClient`
- `@appstrate/env` -- `getEnv()` (Zod-validated, cached, fail-fast)
- `@appstrate/connect` -- OAuth2/PKCE, credential encryption (v1 envelope + multi-key keyring)
- `@appstrate/afps-runtime` -- portable bundle loader + signing + sinks + Pi runner
- `@appstrate/mcp-transport` -- MCP SDK adapter (createMcpServer, createInProcessPair, createMcpHttpClient)
- `@appstrate/shared-types` -- Drizzle InferSelectModel re-exports
- `@appstrate/emails` -- Email template rendering

### Per-area guides

Loaded only when working there — each is the copy that gets updated:

- **`apps/api/AGENTS.md`** — backend conventions: multi-tenant filtering, request pipeline, route guards, RBAC, rate limiting, package versioning, Zod/AJV validation, and the headless platform (spaces, end-users, webhooks, idempotency, API versioning, OpenAPI spec).
- **`apps/web/AGENTS.md`** — `apps/web` + `packages/ui` conventions: i18n, Tailwind 4, typed API client, React Query keys, SSE hooks, feature gating, Rules-of-React gate.
- **`apps/cli/AGENTS.md`** — the odd one out: an operating manual for an agent driving a live instance, not conventions for changing `apps/cli` itself.
- **`apps/api/src/modules/README.md`** — module authoring: lifecycle, permissions, hooks, database ownership rules.

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
     |   │  AGENT_PROMPT, LLM_*; SIDECAR_AUTH_TOKEN (sidecar- │
     |   │  only bearer, NOT the run token); it + SIDECAR_URL │
     |   │  deleted after bootstrap; NO RUN_TOKEN             │
     |   └────────────────────────────────────────────────────┘
```

Sidecar + agent setup run in parallel (`Promise.all`). Images pre-pulled at boot (`ensureImage`) and kept warm afterwards by the runtime-image warmer (`services/orchestrator/runtime-image-warmer.ts`: reconciles one `appstrate-imagepin-*` holder container per image, so host-level `docker image prune -a` can't put a cold pull back on the run-boot path). Full sidecar protocol: `docs/architecture/SIDECAR.md`.

The platform, `PI_IMAGE` and `SIDECAR_IMAGE` are a **version contract**, not three independent knobs: the agent runtime and the sidecar speak a wire protocol to each other, both speak a container boundary to the platform, and all of it changes in the same commit — a trio that disagrees boots fine then fails runs with an opaque upstream error naming none of the three (#1195 for the pair, #1177 for the platform boundary). Two guards, and they are complementary, not redundant. The env schema (`@appstrate/env`, via `findRuntimeImageTagMismatch` from `@appstrate/core/image-ref`) **fails boot** on a disagreement — a cross-field rule like the S3/APP_URL ones, not conditioned on `RUN_ADAPTER`. The two halves are not symmetric: `PI_IMAGE` and `SIDECAR_IMAGE` are always compared to each other literally (every compose file sets both from one `${APPSTRATE_VERSION}`, so any difference is a half-done edit), while the platform joins only when all three values are **release versions**. That predicate is the load-bearing part: the platform's version is `APP_VERSION`, baked into the image by the Dockerfile (`ARG` → `ENV`, fed by the release workflow's tag), i.e. a git ref name, so it can equal an image tag only in the one family (`{{version}}`) the two namespaces share. Comparing it against the other three families `release.yml` publishes for the same image (`latest` — the documented compat fallback —, `{{major}}.{{minor}}`, `sha-<sha>`) or against a non-release build stamp (`dev`, the ARG default and source-run fallback; `health-container-e2e`, what the health e2e job builds with, against `:local` images) does not detect skew, it makes the rule unsatisfiable. Any of those takes the platform out of the trio and the rule degrades to the pair rule, which is what keeps dev boxes, preview deployments, that CI job and `:latest` consumers booting. A digest-pinned ref (either half) is exempt outright. The cost of the predicate, deliberately accepted: both refs floating on `:latest` under a released platform is now accepted, because `APP_VERSION` reads the same whether the platform image was pulled by version tag or by `:latest` — that trio is byte-identical to the supported all-`:latest` deployment, and only the revision guard below can tell them apart. That guard is configuration-only: after the pre-pull, `services/orchestrator/runtime-image-pair.ts` **warns** when the two images on the host carry different `org.opencontainers.image.revision` stamps — _same tag, two builds_ (`:latest` rebuilt on one side only), which tag comparison structurally cannot see. `bun run docker:build:runtime` (alias `build-runtime`) builds BOTH images with the same stamp — there is deliberately no command that rebuilds one half.

**Run liveness is two-phase** (`services/run-watchdog.ts`, same split as Kubernetes `startupProbe` vs `livenessProbe`): until the runner's first event the platform is provisioning and attests liveness on its behalf (`services/run-boot-heartbeat.ts`), bounded by `runs.boot_deadline_at` (`RUN_BOOT_DEADLINE_SECONDS`, default 300s); after it, the runner's own heartbeat owns liveness (`RUN_STALL_THRESHOLD_SECONDS`, default 60s). Each predicate finalises with its own error.

### AFPS Integrations (summary)

Outbound third-party API access flows through **integrations** (agent-driven connection model). An integration declares `source.kind: "local"` (sandboxed runner container per integration, `node|python|binary|uv`) or `"remote"` (Streamable HTTP / SSE MCP). Credentials injected sidecar-side (env-delivery or per-run MITM proxy), never read by the integration's MCP server. OAuth scopes inferred per-agent from `tools[]` selection.

Agent manifest splits dependency from config: version on `dependencies.integrations.<id>` (flat semver), tool/scope/auth selection in top-level `integrations_configuration.<id>`. Single read/write path: `parseManifestIntegrations` / `writeManifestIntegrations` (`@appstrate/core/dependencies`).

**Full detail** (runtime spawn, MITM, niveau-2 scope phases, remote HTTP, MCP transport retry): `docs/architecture/INTEGRATIONS_RUNTIME.md`. AFPS wire spec (canonical): <https://github.com/appstrate/afps-spec/blob/main/spec.md>.

### Agent runtime — MCP-only

**`docs/architecture/SIDECAR.md` owns this surface** — the tool list, the argument shapes, the auth token, the SSRF tiers and the `/llm/*` behaviour all live there, next to the retry and egress detail that only makes sense alongside them. Do not re-describe them here; a second copy drifts, and the copy that used to live here had. The shape, so you can recognise it:

- The sidecar exposes `/mcp` (Streamable HTTP, stateless JSON-RPC) as the agent's exclusive cross-boundary surface, alongside `/health`, `GET /integrations/boot-report` and `ALL /llm/*`
- Tools are registered as Pi tools at container boot (`runtime-pi/mcp/direct.ts`): `{ns}__api_call` (+ `{ns}__api_upload`) per opted-in integration auth, plus the first-party `run_history` and `recall_memory`
- Every route except `/health` requires the per-run `x-appstrate-sidecar-auth` token; deny-by-default middleware in `runtime-pi/sidecar/app.ts`
- Zero-knowledge enforcement: after MCP bootstrap, `runtime-pi` deletes BOTH `process.env.SIDECAR_URL` and `process.env.SIDECAR_AUTH_TOKEN` — the URL removes the convenience, the token removes the capability
- The legacy HTTP `/proxy` and `/run-history` routes are fully retired — runners 1.x are not compatible

### Docker Integration

- Sidecars are spawned per-run; image pre-pull at orchestrator init absorbs cold-pull (20-45s) off the first run
- Credential isolation: agent calls sidecar proxy, never sees raw credentials
- Multiplexed stream headers: `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`

### Memory model — `note` / `pin` / `recall_memory`

- Single `package_persistence` table with `(actor_type, actor_id)` scope (`member` / `end_user` / `shared`) and orthogonal `(key, pinned)` attributes
- Three quadrants: archive (key=null, pinned=false), pinned memo (key=null, pinned=true), pinned named slot (key=string, pinned=true)
- Write tools: `note(content, scope?)` and `pin(key, content, scope?)` are **runtime tools**, defined in `packages/core/src/runtime-tool-defs.ts` and selected per agent via `runtime_tools`. They are not packages — there is no `@appstrate/note` or `@appstrate/pin` in `system-packages/`
- Legacy `add-memory` / `set-checkpoint` system tools are retired; `runs.state` + `package_memories` are merged into `package_persistence`
- Wire format: `RunResult.pinned: Record<string, PinnedSlot>` (top-level `RunResult.checkpoint` mirror was dropped)

### AFPS bundle runtime — `@appstrate/afps-runtime`

- Portable bundle runner (`packages/afps-runtime/`) drives the platform's run pipeline and ships a standalone `afps` CLI, which is **bundle tooling only**: `keygen` / `sign` / `verify` / `inspect` / `render` / `bundle` / `conformance` (`packages/afps-runtime/src/cli/index.ts`). It has no `run` and no `test` — live LLM execution is `appstrate run`, which bundles this runtime
- Multi-package `.afps-bundle` format with Merkle-root integrity (per-file RECORD SRI → per-package SRI → bundle-level SRI on canonical map)
- Endpoints: `GET /api/agents/:scope/:name/bundle` (export) + `POST /api/packages/import-bundle` (accepts `.afps-bundle` and legacy `.afps`)
- Signature policy via `AFPS_SIGNATURE_POLICY` env (`off` | `warn` | `required`) and `AFPS_TRUST_ROOT` allowlist

## Key Conventions & Gotchas

### Casing conventions (snake_case wire / camelCase TS internal)

Authoritative reference: **`docs/CASING_CONVENTIONS.md`**. TL;DR:

- **Wire JSON** (HTTP, AFPS manifests, OpenAPI, OAuth2 fields, SQL columns) → **snake_case**
- **Drizzle TS schema fields** → **camelCase** TS / **snake_case** SQL alias (`userId: text("user_id")`)
- **TS internal** (args, vars, React props, Zustand state) → **camelCase**
- **Universal DB-convention fields** (the EXACT list in `docs/CASING_CONVENTIONS.md` 4b — `id`, `userId`, `runId`, `createdAt`, `expiresAt`, `runNumber`, …; a name, never a `*Id` pattern) → **camelCase EVERYWHERE** (Drizzle, wire, OpenAPI, frontend)
- **Better Auth tables** → camelCase TS (HARD framework blocker)
- **Module hooks, logger fields, CloudEvents, webhook deliveries, BullMQ jobs, audit-log `after` payloads** → camelCase

When in doubt: wire = snake_case, internal = camelCase. Audit: `/audit-casing` (6 parallel agents, 100% compliance check).

**Package IDs in URL paths**: two shapes by rule — single package → `{scope}/{name}`, route referencing ≥2 packages → `{packageId}` (e.g. `/api/integrations/*`). Both resolve to the same `@scope/name` wire path. Always encode with `encodePackageIdPath` from `@appstrate/core/naming` — never `encodeURIComponent` on the whole id (it 404s the route regexes). Full rule: `docs/CASING_CONVENTIONS.md` → "Package identifiers in URL paths".

### Module System

Formalized system for optional features. Contract in `@appstrate/core/module` (published on npm) so external modules implement without depending on the API package. **Authoring guide + full lifecycle/permissions/hooks detail: `apps/api/src/modules/README.md`.**

Essentials:

- **Discovery**: loader resolves each `MODULES` specifier against `apps/api/src/modules/<id>/index.ts` first, then npm import. No registration table — drop a directory + add id to `MODULES`.
- **Lifecycle**: core migrations (incl. all module tables) → discover built-ins → topological sort by `manifest.dependencies` → aggregate permissions → `init()` (workers only — no migrations) → `createRouter()` → running → `shutdown()`. All declared modules required; any failure is fatal.
- **Modules own no tables**: a module is pure behavior — no module `schema.ts`, no per-module migration tree, no `__drizzle_migrations_<id>`. All OSS tables, including those a module reads/writes, live in the core schema (`packages/db/src/schema/`) and are created by the system migration pipeline at boot. **`apps/api/src/modules/README.md` § "Database ownership rules" owns this rule** — it states the four sub-rules (where a module's tables are defined, how Better Auth resolves them, why core never imports from a module, and the separate-journal escape hatch `@appstrate/module-ee` uses) next to the module contract they constrain, so that is the copy to read and to update.
- **Built-in dirs** (`apps/api/src/modules/`): `webhooks` (clean `onRunStatusChange` boundary; tables `webhooks`/`webhook_deliveries` in core schema), `oidc` (end-user OAuth 2.1 IdP — reference consumer of `authStrategies()` / `betterAuthPlugins()`; its OAuth/jwks tables live in core schema `schema/oidc.ts`), `core-providers` (openai/anthropic/openai-compatible model providers via `modelProviders()`, owns no tables), `mcp` (the platform REST API exposed as an inbound MCP server, one endpoint per org at `/api/mcp/o/:org` + RFC 9728 discovery; every operation behind the three progressive-disclosure tools `search_operations`/`describe_operation`/`invoke_operation`, plus the `run_and_wait` shortcut and six file/package/identity helpers, declared per the caller's grants (the invoke, run, file-listing and package-import tools appear only when the grants behind them hold; the read-only helpers are always declared), dispatched in-process through the app so RBAC is the REST pipeline's; keeps its RFC 8707 audience allowlist live off `onOrgCreate`/`onOrgDelete`, owns no tables), `firecracker` (OPT-IN — NOT in the `MODULES` default; contributes a single `firecracker` execution backend via `orchestrators()` — an HTTP client to the `appstrate-runner` host daemon (`bun run firecracker:runner`) which embeds the in-process `FirecrackerOrchestrator` engine; platform reads only `FIRECRACKER_RUNNER_URL`/`_TOKEN`, the host-side `FIRECRACKER_*` vars are daemon-only, no tables/routes; see `docs/architecture/FIRECRACKER.md`).
- **Workspace modules** (`packages/module-*`, not built-in dirs): `@appstrate/module-chat` (the one of them in the `MODULES` default — the dashboard's chat surface), `@appstrate/module-codex` + `@appstrate/module-claude-code` (OPT-IN — NOT in the `MODULES` default; subscription grey-zone — both are agent-run **executable** on the single Pi engine via a provider-neutral sidecar bearer-swap, see `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`), `@appstrate/module-observability` (OPT-IN — OpenTelemetry provider for the core telemetry façade `@appstrate/core/telemetry`; see `docs/architecture/OBSERVABILITY.md`) and `@appstrate/module-ee` (OPT-IN — Stripe billing, credit quotas, usage metering; the one **source-available** package here, `packages/module-ee/LICENSE`, and the one module with a migration tree of its own — its `ee_*` tables live in the platform database under the journal `drizzle.ee_migrations`; see `packages/module-ee/README.md`) are resolved through `workspace:*`.

- **Hooks vs Events**: a hook's dispatch mode is fixed by the contract **per hook name**, not by the call site — `packages/core/src/module.ts` splits the map in two and the platform's two dispatchers each accept only their own half. `callHook` runs `FirstMatchHooks` — `beforeUsage` alone, the admission gate over metered LLM usage on a surface (`run` | `chat`); the first module providing it answers and the rest are never consulted. `callAllHooks` runs `BroadcastHooks` — `beforeSignup`/`afterSignup`, called on **every** module in load order with errors **propagating**, so a throwing `beforeSignup` aborts user creation. Events (`emitEvent`) broadcast as well but are side-effect only (`onRunStatusChange`/`onRunConnectionMissing`/`onOrgCreate`/`onOrgDelete`/`onOrgMemberRemove`) and a throwing handler is **isolated** — that isolation is the whole difference from a broadcast hook. Platform calls by name, never by module ID.
- **Permissions**: RBAC co-owned by core + modules. Core catalog in `@appstrate/core/permissions`; role-grant matrix in `apps/api/src/lib/permissions.ts`. Modules extend via declaration merging on `ModuleResources` + `permissionsContribution()`. All three guards (`requirePermission`, `requireCorePermission`, `requireModulePermission`) delegate to `makePermissionGuard` in core.
- **Disabling = zero footprint**: remove from `MODULES` → not imported/initialized; no tables/routes/middleware/flags/RBAC. Scheduling + provider management deliberately live in **core** (coupling with `runs` made module isolation cost more than it delivered).

### Progressive Infrastructure

Tiered model — every external dependency is optional with a built-in fallback. Adapters in `apps/api/src/infra/` with dynamic imports.

| Component                     | Fallback                        | Detail                         | Tier |
| ----------------------------- | ------------------------------- | ------------------------------ | ---- |
| PostgreSQL (`DATABASE_URL`)   | PGlite (embedded WASM Postgres) | `./data/pglite/`               | 1+   |
| Redis (`REDIS_URL`)           | In-memory adapters              | EventEmitter, Map, local queue | 2+   |
| S3/MinIO (`S3_BUCKET`)        | Filesystem storage              | `./data/storage/`              | 3    |
| Docker (`RUN_ADAPTER=docker`) | Bun subprocesses                | No container isolation         | 3    |

Tier 0 (zero-install) requires only Bun.

### API Routes

- **OpenAPI specs** in `apps/api/src/openapi/` are the source of truth. Never quote an endpoint count from memory — `bun run verify:openapi` prints the live `Code ⊆ Spec` figure
- All route bodies validated with `parseBody(schema, body)` from `lib/errors.ts`
- Error responses follow RFC 9457 `application/problem+json`
- `Request-Id` (`req_` prefix) on all responses

### Backend Patterns

- Auth: cookie session + `X-Org-Id` / `X-Space-Id`, API key (`apst_*`) tried first — § "Stack — Critical Constraints" has the full rule
- Request pipeline: error handler -> Request-Id -> CORS -> health -> auth -> org context -> routes
- Route guards (`middleware/guards.ts`): `requireAgent()`, `requireActiveAgent()`, `requirePackageInOrg()`, `apiKeyOrgScopeGuard()`/`pinnedSpaceScopeGuard()`. RBAC is `requirePermission(resource, action)` (`middleware/require-permission.ts`) — there is **no** `requireAdmin()` / `requireOwner()`
- Rate limiting: Redis-backed, keyed by `method:path:identity`

### Frontend Patterns

- i18next: `fr` (default) + `en`. The namespace list lives in `apps/web/AGENTS.md` (first bullet) — it sits next to the `apps/web/src/locales/{lang}/` files it names, so it is the copy that gets updated when a namespace is added
- **Typed API client only** — `apps/web/src/api/client.ts`: `$api.useQuery("get", "/api/end-users", { params })` / `$api.useMutation(...)` (openapi-react-query) and raw `client.GET(...)` (openapi-fetch), typed against `api/schema.d.ts` (regenerate with `bun run generate:api`). The legacy fetch barrel `api.ts` is **deleted** and its import specifiers are **banned by ESLint** (`eslint.config.mjs`) — code written against it will not lint
- React Query keys: typed-client hooks use `[method, path, init]` (org/space scope rides in `init`). Run/schedule/package caches keep pinned legacy keys because the SSE patcher invalidates by those names
- Feature gating: `useAppConfig()` reads `window.__APP_CONFIG__` (injected at serve time)
- Always use `<Modal>` from `components/modal.tsx` for dialogs

### Database

Core schema: `packages/db/src/schema/` (Drizzle, barrel via `schema/index.ts`) — includes the tables modules read/write (e.g. `schema/oidc.ts`, `schema/webhooks.ts`). Modules own no separate schema, no migrations, no `schema.ts` of their own. Key headless tables: `spaces` (`spc_`), `endUsers` (`eu_`), `spacePackages`.

- **No RLS** — all queries filter by `orgId` at the application level (+ `spaceId` for space-scoped resources)
- Table counts drift — derive them, don't quote them: `grep -c "= pgTable(" packages/db/src/schema/*.ts`
- Migrations are **applied automatically at boot** (PGlite + PostgreSQL); `bun run db:migrate` is a manual escape hatch, not part of the normal loop. Adding one: § "Development Workflow" below, and § "Migrations" for the `db:generate` TTY/index-collision trap
- Service layer: function-based (no classes), `apps/api/src/services/state/` (runs, notifications, package-persistence) is the central data-access layer

## Development Workflow

- **New API route**: route file in `routes/` + OpenAPI path file in `openapi/paths/` + wire in `index.ts`. Run `bun run verify:openapi`, then `bun run generate:api` to refresh the SPA's generated types (`verify:api-types` in `check` fails otherwise). Every 2xx JSON response must declare a schema (verify-openapi step 6).
- **DB migration (core)**: edit the domain file under `packages/db/src/schema/<domain>.ts` (the barrel is `packages/db/src/schema/index.ts` — nothing is defined there) → `bun run db:generate` (needs `DATABASE_URL` for drizzle-kit — read § Migrations below before running it, it has a TTY and an index-collision trap). Applied automatically at boot (PGlite + PostgreSQL).
- **Module tables**: there are none separately — a module's tables live in the core schema (`packages/db/src/schema/<domain>.ts`) and migrate with core. No per-module migration step. The one exception is `packages/module-ee`, which keeps a drizzle tree of its OWN and self-migrates its own `ee_*` tables into the platform database at `init()`, under its own journal `drizzle.ee_migrations` — the platform's `drizzle.__drizzle_migrations` is untouched. That is the escape hatch of `apps/api/src/modules/README.md` § "Database ownership rules" (rule 4), for tables the Apache-2.0 core schema must not carry.
- **Quality gate**: `bun run check` — see § "Quality Gate — and the signals it lies with" below for the task list and the steps that lie.
- **Dead code**: `verify:dead-code` runs knip over every workspace and fails on an exported symbol
  with no reader, a file nothing reaches, or a declared dependency nothing imports. `eslint`'s
  `no-unused-vars` cannot see any of that — it only sees locals. Config and the reasoning behind
  every entry/ignore: `knip.config.ts`. An entry must say _what reaches the file_; an ignore must
  say _why the finding cannot be acted on_. Never un-export a symbol to quiet this gate, and add an
  `ignore*` only where knip is structurally blind or the code is vendored in whole, with the
  justification `knip.config.ts` demands at the call site — never to make a finding go away. What
  is out of scope, what knip derives on its own, and the ~161-finding false red the rule came out
  of: `docs/QUALITY_GATE.md`.
- **Tests**: `bun test` from root runs all packages in one process. See **Testing** below.

### Migrations

`bun run db:generate` needs a TTY and collides on index numbers when two
branches both add the next one. Hand-write the `.sql`, the `meta/_journal.json`
entry and the `meta/NNNN_snapshot.json`, then prove the snapshot rather than
trusting it: copy it aside and run `bunx drizzle-kit generate` — a correct
snapshot yields `No schema changes, nothing to migrate`. Tier-0 tests replay the
whole chain from `0000` under PGlite, so a malformed migration fails there
loudly.

A migration that changes the schema also regenerates **`packages/db/schema-catalog.txt`** — the
fingerprint of what the chain builds (columns, indexes, constraints, enum labels; the query is
`scripts/schema-catalog.sql`). Migrate an EMPTY Postgres 16 database with
`bun packages/db/src/migrate.ts`, then `bun run verify:schema-catalog --write` against it, and commit
the file; the `schema-catalog` job in `check.yml` fails until you do. It is not in `bun run check`
because it needs a database. Its point is outside CI: the same query run on production and diffed
against this file is how a long-lived database's drift from the chain shows up (#1507, release
runbook Phase 2a).

## Quality Gate — and the signals it lies with

`bun run check` is the gate. It is honest in CI and in a plain clone; several of
its steps report false green or false red locally, and each one below has cost
real time. Establish which you are looking at BEFORE changing code.

The tasks, in the order `package.json` lists them — **21 task names** in one turbo invocation, and
this is the copy kept in step with it: `turbo typecheck lint format:check` plus
`verify:openapi`, `verify:api-types`, `verify:type-coverage`, `verify:compose-defaults`,
`verify:release-version`, `verify:env-docs`, `verify:workflows`, `detect:breaking`,
`build:system-packages:check`, `lint:manifest-casing`, `conformance:check`,
`verify:module-isolation`, `verify:module-sql-boundary`, `verify:license-boundary`,
`typecheck:scripts`, `verify:module-contract`, `verify:dead-code`, `verify:no-migration-dml`.
turbo fans those out to **42** actual tasks (`typecheck` alone runs in 22 workspaces) — count them
with `bunx turbo run <the 21 names> --dry=json`, never by reading this line.
There is no `turbo check` task — the root script drives turbo directly.

Two steps surprise people. `verify:release-version` fails when the `${APPSTRATE_VERSION:-…}`
fallback baked into the shipped compose files falls behind the newest `v*` tag (it went twelve
releases stale before the gate existed), and `verify:env-docs` fails when `docs/ENV.md` drifts from
the `@appstrate/env` schema or `.env.example`. Both are release/ops correctness, not code style —
do not "fix" either by editing the gate.

`verify:workflows` is the narrowest: `actionlint` over `.github/workflows`, the
one language in this repo the gate used to skip entirely. It downloads a version-pinned,
SHA-256-verified binary on first run and caches it under `node_modules/.cache` — the npm package
named `actionlint` is an unrelated abandoned wasm build, not the linter. Its `shellcheck` and
`pyflakes` integrations are switched OFF on purpose so the verdict cannot depend on what happens
to be installed on the host; `scripts/verify-workflows.ts` states the full reasoning.
`verify:module-sql-boundary` is what enforces "a module never joins across the licence boundary"
(`apps/api/src/modules/README.md` rule 4): `@appstrate/module-ee` keeps its tables in the PLATFORM
database, so a `SELECT … FROM organizations` written there compiles and runs. The gate refuses any
import of the platform's drizzle schema from a module that owns a migration journal, and any table
named in that module's raw SQL that its own drizzle snapshot does not declare.

**`verify:dead-code` (knip)** produced a ~161-finding false red on an untouched `main` until
2026-08-23, and the failure mode is easy to re-introduce with one careless edit to `knip.config.ts`:
declaring `entry` for a workspace **replaces** knip's filename defaults, so a workspace that declares
one must carry every `exports` target, every `bin` target, and `main`/`module` if present —
`manifestEntries(workspace)` derives that half; call it, never transcribe its output. The full
forensics (what each knip version does and does not derive, which hypotheses were measured and
refuted, and the two shapes of `ignore*` that qualify) live in **`docs/QUALITY_GATE.md`**.

### Other false signals from the same chain

| signal                                                  | why it lies                                                                                            | what to do instead                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `turbo` prints `Cached: N` for `typecheck`              | nothing was re-checked                                                                                 | `bunx tsc --noEmit -p <pkg>/tsconfig.json`, per package, no turbo |
| `bunx turbo …` fails with `Could not resolve workspace` | it resolves a _global_ turbo, and rewrites `bun.lock` on the way                                       | `./node_modules/.bin/turbo`                                       |
| a backgrounded `cmd > log; echo $?` reports 0           | that is the exit code of `echo`                                                                        | read the `Tasks: N/M` line in the log, not the reported status    |
| `bun test` passes but types are broken                  | tests do not typecheck                                                                                 | re-run `tsc` after any mechanical rename                          |
| `codecov/patch` is red                                  | coverage arrives from two jobs; the status is computed after the first and recomputed after the second | wait for the `integration` upload before drawing any conclusion   |
| a PR shows "no checks reported"                         | usually `mergeable: CONFLICTING`, not a slow CI                                                        | `gh pr view <n> --json mergeable,mergeStateStatus`                |

## Testing

The skill **`testing`** (`.claude/skills/testing/SKILL.md`) owns the full guide — tiers and the `bunfig.toml` preload, module auto-discovery, directory layout, the conventions table, DB isolation and cleanup. What follows is the short form: the commands, the helpers, and the rules that get broken most.

### Running Tests

```sh
bun test                          # Full suite; Docker tests skip unless TEST_DOCKER=1
bun test apps/api/test/unit/      # API unit tests only (fast, no DB)
bun test apps/api/test/           # API unit + integration
bun test runtime-pi/              # Runtime + sidecar tests
bun test packages/core/           # Core library tests (no DB)
bun test packages/afps-runtime/   # AFPS bundle runtime tests
```

### Test Conventions

**`.claude/skills/testing/SKILL.md` owns the conventions table** — framework,
`it()` vs `test()`, file naming, DB isolation and cleanup, `app.request()` vs
`Bun.serve()`, real-auth sign-up, and the `mock.module()` ban with the injection
patterns that replace it. It also owns the tier/preload wiring those rules
depend on, which is why it is the copy that stays right. Read it before writing
a test; the two rules worth carrying in your head are `bun:test` with `it()`
(never vitest/jest, never `test()`), and **no `mock.module()`** — use dependency
injection.

### Test Helpers (`apps/api/test/helpers/`)

| Helper          | Purpose                                                      |
| --------------- | ------------------------------------------------------------ |
| `app.ts`        | `getTestApp()` -- full Hono app replica (no boot/Docker)     |
| `auth.ts`       | `createTestUser()`, `createTestOrg()`, `createTestContext()` |
| `db.ts`         | `truncateAll()` -- DELETE FROM all tables in FK-safe order   |
| `seed.ts`       | 15+ factories: `seedPackage()`, `seedRun()`, etc.            |
| `assertions.ts` | `assertDbHas()`, `assertDbMissing()`, `assertDbCount()`      |
| `redis.ts`      | `flushRedis()`, `closeRedis()`                               |

### Writing a New Test

```typescript
// Unit test (no DB)
import { describe, it, expect } from "bun:test";
import { myFunction } from "../../src/services/my-service.ts";

describe("myFunction", () => {
  it("returns expected result", () => {
    expect(myFunction("input")).toBe("expected");
  });
});
```

```typescript
// Integration test (real DB + HTTP)
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
});
```

### Mocking Policy — No `mock.module()`

**Never use `mock.module()`.** It replaces the entire module globally and permanently within a test run, breaking other tests importing the same barrel. (Source of 37 hard-to-diagnose failures.) Use dependency injection instead — see the `testing` skill.

## Environment Variables

`getEnv()` from `@appstrate/env` (Zod-validated, cached, fail-fast at boot) is authoritative. **Full table: `docs/ENV.md`.**

**Do not copy the full env table into this file.** Every hand-maintained copy of the env contract in
this repo has drifted from the schema; the generator is authoritative and cheap to read:

| Source                      | What it is                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/env/src/index.ts` | **Authoritative** — the Zod schema. Names, defaults, refinements, required-ness. Wins on any conflict.                                            |
| `docs/ENV.md`               | Prose reference — one row per var, plus the handful of sidecar/module vars read straight from `process.env` and therefore absent from the schema. |
| `.env.example`              | Operator contract — dev-ready values, commented by default.                                                                                       |

Required vars (boot fails without them):

| Variable                    | Notes                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`        | Session signing secret                                                          |
| `CONNECTION_ENCRYPTION_KEY` | 32 bytes base64. Primary key for new credential ciphertexts (v1 envelope)       |
| `UPLOAD_SIGNING_SECRET`     | HMAC secret for FS upload-sink tokens (≥16 chars), rotates independently        |
| `RUN_TOKEN_SECRET`          | HMAC secret for run bearer tokens (≥16 chars), rotates independently            |
| `CONNECT_SESSION_SECRET`    | HMAC secret for hosted-connect-portal tokens (≥16 chars), rotates independently |

Everything else has a schema default. To list the current key set:

```sh
grep -oE '^    [A-Z][A-Z0-9_]*:' packages/env/src/index.ts | tr -d ' :' | sort
```

Most-touched optional vars: `MODULES` (a fixed default set — neither all the OSS modules nor none of them, so read its `.default(...)`; `firecracker`, `@appstrate/module-observability`, `@appstrate/module-ee` and the two subscription modules sit outside it), `DATABASE_URL`, `REDIS_URL`, `S3_BUCKET`, `RUN_ADAPTER` (default `process`; `docker` for containers), `APP_URL`, `TRUSTED_ORIGINS`, `TRUST_PROXY`. See `docs/ENV.md` for every documented var with defaults and full notes — most of them the `@appstrate/env` Zod schema's key set, the rest read straight from `process.env` by modules, the sidecar or the agent container. **Nothing recognises a renamed env var — not the platform, not the CLI.** `RETIRED_ENV_RENAMES`, its boot guard and the two RETIRED-name doc tables were all deleted under `docs/NO_TRANSITIONAL_CODE.md` §4. An `.env` carrying a pre-rename spelling has that key stripped as unknown and the setting falls back to its default, silently; correcting it is an operator task announced in the release notes. Do not re-add a rename table anywhere, the installer included — §4 records why the installer is not a loophole. `bun run verify:env-docs` (in `bun run check`) holds the documented table complete against both the schema and `.env.example` and prints the counts — read its success line, not this sentence.

`MODULES` is the var most often mis-quoted from memory — read its `.default(...)` in the schema
rather than any doc, this one included.

## Agent & Extension Gotchas

- **Reference manifest**: the system package `.afps` archives in `system-packages/`. Validation: `services/schema.ts`.
- **JSON Schema `required`**: top-level `required: ["field1"]` array — NOT `required: true` on properties.
- **Schema wrapper convention**: input/output use an AFPS wrapper — NOT raw JSON Schema. Structure: `{ schema: JSONSchemaObject, file_constraints?, ui_hints?, property_order? }` (snake_case, AFPS §3.4). `schema` member MUST be pure JSON Schema 2020-12. File fields: `{ type: "string", format: "uri", contentMediaType: "..." }` (single) or array of same (multiple) — NEVER `type: "file"`. Detect via `isFileField()` / `isMultipleFileField()` from `@appstrate/core/form`.
- **Extension import**: `@earendil-works/pi-coding-agent` (NOT `pi-agent`).
- **Extension `execute` signature**: `(_toolCallId, params, signal)` — `params` is the **second** arg.
- **Extension return type**: `{ content: [{ type: "text", text: "..." }] }` — NOT a plain string.
- **Extension failure = throw**: Pi ignores an `isError` on a value returned from `execute`; a throw is what flags the call as failed (`tool_execution_end.isError`, run log `Tool error`). Runner tools return through `piToolResultOrThrow` (`@appstrate/runner-pi`). A throw keeps only the message — a tool whose failures must keep `details` flags them from a `tool_result` handler instead.
- **Skills**: YAML frontmatter (`name`, `description`) in `SKILL.md`, parsed with the **`yaml` library at the same major the skill runtime uses** (`@earendil-works/pi-coding-agent`) so the gate and the consumer never disagree. Both fields are REQUIRED on every path that WRITES skill content (editor create/save, publish, restore, ZIP/GitHub import, bundle/MCP import — ROOT package only) via `checkSkillMarkdown` (`@appstrate/afps-shared/companion-files`), wired once as `validateContent` on `CONFIG_BY_TYPE` and applied through `assertContentConforms` / `assertArchiveContentConforms` (`services/package-items/config.ts`): `name` is the bare [Agent Skills](https://agentskills.io/specification) slug (1-64 code points of lowercase `a-z`/`0-9`/`-`, no leading, trailing or doubled hyphen) written INLINE on one line, a DIFFERENT namespace from the `@scope/name` package id; `description` non-empty, ≤1024 code points; a leading BOM is refused — Pi strips one from 0.85 on, but a minted version is immutable and must load on every runtime image the platform ships, including the 0.84.x ones that read no frontmatter behind a BOM — so write paths starting from BYTES decode via `decodeSkillMarkdown`. READING stays lenient — `checkCompanionFiles` (the loader) still asks only for an inline `name`, because published bundles are immutable and a run must not fail on a skill nobody can fix; the gate must therefore accept a SUBSET of what the loader accepts, and `packages/runner-pi/test/skill-frontmatter-parity.test.ts` runs the real Pi loader to keep the asymmetry one-directional. Container path `.pi/skills/{id}/SKILL.md`.
- **Integration manifests** follow the same write-strict / read-lenient split: `checkManifest` on `CONFIG_BY_TYPE` (`findNonSnakeCaseIdentityClaimKeys`, `@appstrate/core/integration`) refuses a non-snake_case `identity_claims` key on those write paths, never in `integrationManifestSchema`, so a published manifest predating the rule still loads.
- **Proxy system**: org-level CRUD `/api/proxies` (admin). System proxies from `SYSTEM_PROXIES` env at boot. Agent override `GET/PUT /api/agents/{scope}/{name}/proxy`. Cascade: agent → org default → `PROXY_URL`.
- **Space-scoped input defaults**: an agent's stored input values and its per-field locks live together in one jsonb column, `space_packages.input_settings` (`{ values, locked }`), per-space. Its single write path is `PUT /api/agents/{scope}/{name}/input-settings`; on the wire the pair is `{ values, locked_fields }`. `package_persistence` (memory archive + pinned slots) also space-scoped, row-partitioned by `(actor_type, actor_id)` (members + end-users never read each other's state).
- **Run lifecycle**: `pending` → `running` → `success` | `failed` | `timeout` | `cancelled`. Transitions via `updateRun()` in `services/state/runs.ts`. `pg_notify` on every change → SSE. Concurrent runs per agent supported (`run-tracker.ts`).
- **Enriched run responses**: `listRunsWithFilter`/`getRunFull` LEFT JOIN to add `user_name`, `end_user_name`, `api_key_name`, `schedule_name`. `EnrichedRun` (`@appstrate/shared-types`) is `RunWireDto` plus these. Frontend reads names directly — no separate lookups.
- **Run trigger tracking**: `runs.apiKeyId` (FK → `api_keys.id`, ON DELETE SET NULL) records triggering key. With `userId`/`endUserId`/`scheduleId` → full trigger attribution.

## Operational Notes & Known Limitations

- **Run launch is not a streaming call** (limitation): `POST /api/agents/{scope}/{name}/run` (singular — `/runs` is the GET list) returns `201` with the **full run resource** (same shape as `GET /api/runs/{id}`) — not `202`, and there is no `runId` alias. Progress streams separately via the realtime SSE endpoint; no `stream` field exists in the launch body. Waiting for a terminal status is a separate, supported step, in two forms: `GET /api/runs/{id}?wait=<seconds|true>` long-polls server-side (`services/run-wait.ts`, capped at `MAX_WAIT_SECONDS` = 55 s, below the usual 60 s proxy idle timeout, and degrading to no-wait past the per-identity waiter cap), and the MCP module's `run_and_wait` tool owns launch-plus-wait in one call.
- **Scheduler** (operational): Redis/BullMQ, distributed exactly-once, worker `{ concurrency: 10, limiter: { max: 30, duration: 60_000 } }` — a global abuse backstop, not a serialization mechanism (`services/scheduler.ts`; the old `concurrency: 1, max: 5/min` made every schedule on the instance share one serial ceiling). Synced from `package_schedules` table at boot.
- **Orphan cleanup** (operational): on startup, orphaned runs (`running`/`pending`) marked `failed`; containers labeled `appstrate.managed=true` cleaned via `cleanupOrphanedContainers()` in `docker.ts`.
