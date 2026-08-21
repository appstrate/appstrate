# Appstrate — AI Agent Instructions

Appstrate is an open-source platform for running autonomous AI agents in sandboxed Docker containers. Users connect providers (Gmail, ClickUp, etc.), configure agents, and let AI agents process their data autonomously.

## Build & Development

| Command                  | Description                                                        |
| ------------------------ | ------------------------------------------------------------------ |
| `bun install`            | Install dependencies (use `--frozen-lockfile` in CI)               |
| `bun run dev`            | Start API (:3000) + Vite build --watch (turborepo)                 |
| `bun test`               | Run all tests (bun:test framework, requires Docker)                |
| `bun run check`          | TypeScript + ESLint + Prettier + OpenAPI validation                |
| `bun run build`          | Build everything (turbo build)                                     |
| `bun run db:generate`    | Generate Drizzle migrations from schema changes                    |
| `bun run db:migrate`     | Apply migrations manually (rarely needed — boot migrates on start) |
| `bun run verify:openapi` | Validate OpenAPI spec (structural + lint, 0 errors required)       |

**Runtime**: Bun everywhere -- NOT Node.js. Bun auto-loads `.env`.

### First-time Setup

```sh
bun install
bun run setup     # copies .env, starts Docker infra, runs migrations, builds frontend
bun run dev       # http://localhost:3000
```

Or manually:

```sh
cp .env.example .env
# Every service in docker-compose.dev.yml sits behind a `profiles:` gate, so a
# bare `up -d` starts NOTHING. Use the tier scripts (or pass --profile yourself):
bun run docker:dev            # Tier 3: PostgreSQL + Redis + MinIO (--profile full)
# bun run docker:dev:minimal  # Tier 1: PostgreSQL only
# bun run docker:dev:standard # Tier 2: PostgreSQL + Redis
bun run build
bun run dev                   # migrations are applied automatically at boot
```

## Code Conventions

- **TypeScript strict mode**, no build step for backend (Bun resolves `.ts` directly)
- **No `console.*`** -- use `@appstrate/core/logger` (pino JSON to stdout)
- **No Node APIs** -- use Bun equivalents (`Bun.CryptoHasher`, `Bun.file`, etc.)
- **French UI text** via i18next (`fr` default, `en`), English code/comments
- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **Zod 4** for all request body/query validation (NOT Zod 3). Use `z.url()` not `z.string().url()`
- **AJV** only for dynamic manifest schemas (agent input/output from user-defined manifests)
- **bun:test** with `it()` -- NOT `test()`, NOT vitest/jest
- **File naming**: `*.test.ts` -- NOT `*.spec.ts`

## Architecture

### Monorepo Structure (Turborepo + Bun workspaces)

```
appstrate/
├── apps/
│   ├── api/src/              # Hono API server (:3000)
│   │   ├── routes/           # Route handlers (one file per domain)
│   │   ├── services/         # Business logic, Docker, adapters, scheduler
│   │   ├── modules/          # Built-in modules (core-providers, firecracker, mcp, oidc, webhooks) -- routes + RBAC, NO owned schemas
│   │   ├── openapi/          # OpenAPI 3.1 spec (source of truth for every endpoint)
│   │   └── middleware/       # Auth, rate-limit, guards
│   ├── cli/                  # @appstrate/cli -- channel-aware install + self-update + doctor
│   └── web/src/              # React 19 SPA (Vite + React Query v5 + Zustand)
│       ├── pages/            # Route pages (React Router v7)
│       ├── hooks/            # React Query + SSE realtime hooks
│       ├── components/       # UI components
│       └── stores/           # Zustand stores (auth, org, profile)
├── packages/
│   ├── core/                 # @appstrate/core -- shared validation, storage, utilities (published on npm)
│   ├── afps-shared/          # @appstrate/afps-shared -- zero-internal-dep leaf: bundle/SSRF/credential helpers (published on npm; must be released BEFORE any core release that bumps its range)
│   ├── ui/                   # @appstrate/ui -- React design system (shadcn components, schema-form, widgets) -- private workspace pkg, consumed by web
│   ├── afps-runtime/         # @appstrate/afps-runtime -- portable AFPS bundle runner + signing + conformance + `afps` CLI
│   ├── runner-pi/            # @appstrate/runner-pi -- Pi run driver + container-env builder (SIDECAR_OPERATOR_ENV_KEYS lives here)
│   ├── mcp-transport/        # @appstrate/mcp-transport -- MCP SDK adapter consumed by sidecar + runtime-pi
│   ├── db/                   # @appstrate/db -- Drizzle ORM + Better Auth (ALL tables, incl. the ones modules read/write)
│   ├── env/                  # @appstrate/env -- Zod env validation (authoritative source)
│   ├── emails/               # @appstrate/emails -- Email templates + rendering
│   ├── shared-types/         # @appstrate/shared-types -- Drizzle InferSelectModel re-exports
│   ├── module-*/             # @appstrate/module-{chat,claude-code,codex,observability} -- workspace npm modules (opt-in via MODULES)
│   └── connect/              # @appstrate/connect -- OAuth2/PKCE, API key, credential encryption (v1 envelope + multi-key keyring)
├── runtime-pi/               # Docker image: Pi Coding Agent SDK + sidecar (MCP server) + per-runtime MCP runner images
└── system-packages/          # System package `.afps` archives (skills, mcp-servers, integrations, agents)
```

### Stack

| Layer      | Technology                                                        |
| ---------- | ----------------------------------------------------------------- |
| Runtime    | Bun                                                               |
| API        | Hono (SSE, middleware, routing)                                   |
| Database   | PostgreSQL 16 + Drizzle ORM (no RLS, app-level security by orgId) |
| Auth       | Better Auth (cookie sessions) + API keys (`ask_*` prefix)         |
| Frontend   | React 19 + Vite + React Router v7 + React Query v5 + Zustand      |
| Styling    | Tailwind CSS 4 (`@tailwindcss/vite`, dark theme)                  |
| Validation | Zod 4 (routes) + AJV (dynamic manifest schemas)                   |
| Docker     | `fetch()` + unix socket (NOT dockerode)                           |
| Scheduling | BullMQ (Redis-backed distributed cron)                            |
| Storage    | S3 via `@appstrate/core/storage-s3` (MinIO/R2 compatible)         |
| Build      | Turborepo + Bun workspaces                                        |

## Important Patterns

### API Routes

- **OpenAPI specs** in `apps/api/src/openapi/` are the source of truth. Never quote an endpoint count from memory — `bun run verify:openapi` prints the live `Code ⊆ Spec` figure
- New route: create route file in `routes/` + OpenAPI path in `openapi/paths/` + wire in `index.ts`
- All route bodies validated with `parseBody(schema, body)` from `lib/errors.ts`
- Error responses follow RFC 9457 `application/problem+json`
- `Request-Id` (`req_` prefix) on all responses

### Database

- **No RLS** -- all queries filter by `orgId` at the application level (multi-tenant)
- Schema: `packages/db/src/schema/` (barrel: `packages/db/src/schema.ts`). Counts drift — derive them, don't quote them: `grep -c "= pgTable(" packages/db/src/schema/*.ts`
- Modules own **no** tables. Every table a module reads/writes lives in the core schema and migrates with it
- Migrations: edit the schema -> `bun run db:generate`. **Applied automatically at boot** (PGlite + PostgreSQL); `bun run db:migrate` is a manual escape hatch, not part of the normal loop
- Service layer: function-based (no classes), `apps/api/src/services/state/` (runs, notifications, package-persistence) is the central data-access layer

### Backend Patterns

- No build step: backend ships as `.ts`, Bun resolves directly
- Logging: `lib/logger.ts` (pino JSON) -- never `console.*`
- Auth: Better Auth cookie sessions + `X-Org-Id` header for org context
- API key auth (`ask_*` prefix) tried first, then cookie fallback
- Request pipeline: error handler -> Request-Id -> CORS -> health -> auth -> org context -> routes
- Route guards (`middleware/guards.ts`): `requireAgent()`, `requireOrgAgent()`, `requirePackageInOrg()`, `requireMutableAgent()`, `apiKeyOrgScopeGuard()`/`apiKeyAppScopeGuard()`. RBAC is `requirePermission(resource, action)` (`middleware/require-permission.ts`) — there is **no** `requireAdmin()` / `requireOwner()`
- Rate limiting: Redis-backed, keyed by `method:path:identity`

### Frontend Patterns

- i18next: `fr` (default) + `en`, namespaces: `common`, `agents`, `settings`
- **Typed API client only** — `apps/web/src/api/client.ts`: `$api.useQuery("get", "/api/end-users", { params })` / `$api.useMutation(...)` (openapi-react-query) and raw `client.GET(...)` (openapi-fetch), typed against `api/schema.d.ts` (regenerate with `bun run generate:api`). The legacy fetch barrel `api.ts` is **deleted** and its import specifiers are **banned by ESLint** (`eslint.config.mjs`) — code written against it will not lint
- React Query keys: typed-client hooks use `[method, path, init]` (org/app scope rides in `init`). Run/schedule/package caches keep pinned legacy keys because the SSE patcher invalidates by those names
- Feature gating: `useAppConfig()` reads `window.__APP_CONFIG__` (injected at serve time)
- Always use `<Modal>` from `components/modal.tsx` for dialogs

### Docker Integration

- Docker client: `fetch()` + unix socket -- NOT dockerode (socket bugs with Bun)
- Sidecars are spawned per-run; image pre-pull at orchestrator init absorbs cold-pull (20-45s) off the first run
- Credential isolation: agent calls sidecar proxy, never sees raw credentials
- Multiplexed stream headers: `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`

### Agent runtime — MCP-only

- The sidecar exposes `/mcp` (Streamable HTTP, stateless JSON-RPC) as the agent's exclusive cross-boundary surface
- AFPS tool surface (registered as Pi tools at container boot, `runtime-pi/mcp/direct.ts`):
  - Per spawned integration: `{ns}__api_call({ method, target, headers?, body?, responseMode? })` — credential-injecting outbound proxy. Credentials are injected server-side; URLs validated against `auths.{key}.authorized_uris`.
  - Per spawned integration (when an auth declares `_meta["dev.appstrate/api"].auths.{key}.upload_protocols`): `{ns}__api_upload` — multipart/resumable upload tool.
  - First-party: `run_history({ limit?, fields? })` (past-run metadata via per-run signed token) and `recall_memory({ query?, limit? })` (search the unified `package_persistence` archive).
- The agent's primary completions are served by the `/llm/*` HTTP passthrough route the Pi SDK calls natively; sub-agent flows are handled by spawning a separate run via the platform API
- Zero-knowledge enforcement: after MCP bootstrap, `runtime-pi` deletes `process.env.SIDECAR_URL` so the bash extension cannot discover the sidecar
- The legacy HTTP `/proxy` and `/run-history` routes are fully retired — runners 1.x are not compatible

### Memory model — `note` / `pin` / `recall_memory` (ADR-011/012/013)

- Single `package_persistence` table with `(actor_type, actor_id)` scope (`member` / `end_user` / `shared`) and orthogonal `(key, pinned)` attributes
- Three quadrants: archive (key=null, pinned=false), pinned memo (key=null, pinned=true), pinned named slot (key=string, pinned=true)
- Write tools: `note(content, scope?)` (system tool `@appstrate/note@1.0.0`), `pin(key, content, scope?)` (system tool `@appstrate/pin@1.0.0`)
- Legacy `add-memory` / `set-checkpoint` system tools are retired; `runs.state` + `package_memories` are merged into `package_persistence`
- Wire format: `RunResult.pinned: Record<string, PinnedSlot>` (top-level `RunResult.checkpoint` mirror was dropped)

### AFPS bundle runtime — `@appstrate/afps-runtime`

- Portable bundle runner (`packages/afps-runtime/`) drives the platform's run pipeline and ships a standalone `afps` CLI: `run` / `test` / `sign` / `verify` / `keygen` / `inspect` / `render`
- Multi-package `.afps-bundle` format with Merkle-root integrity (per-file RECORD SRI → per-package SRI → bundle-level SRI on canonical map)
- Endpoints: `GET /api/agents/:scope/:name/bundle` (export) + `POST /api/packages/import-bundle` (accepts `.afps-bundle` and legacy `.afps`)
- Signature policy via `AFPS_SIGNATURE_POLICY` env (`off` | `warn` | `required`) and `AFPS_TRUST_ROOT` allowlist

## Testing

### Running Tests

```sh
bun test                          # Full suite, requires Docker
bun test apps/api/test/unit/      # API unit tests only (fast, no DB)
bun test apps/api/test/           # API unit + integration
bun test runtime-pi/              # Runtime + sidecar tests
bun test packages/core/           # Core library tests (no DB)
bun test packages/afps-runtime/   # AFPS bundle runtime tests
```

### Test Conventions

- **Framework**: `bun:test` -- NOT vitest/jest
- **Test function**: `it()` -- NOT `test()`
- **DB isolation**: `beforeEach(async () => { await truncateAll(); })`
- **App testing**: `app.request()` via Hono -- NOT `Bun.serve()`, no port binding
- **Auth in tests**: Real Better Auth sign-up -> session cookie (not mock auth)
- **DB cleanup**: `DELETE FROM` in FK-safe order (not `TRUNCATE` -- avoids deadlocks)
- **No `mock.module()`**: Use dependency injection instead (global module mocking breaks other tests)

### Test Helpers (`apps/api/test/helpers/`)

| Helper          | Purpose                                                      |
| --------------- | ------------------------------------------------------------ |
| `app.ts`        | `getTestApp()` -- full Hono app replica (no boot/Docker)     |
| `auth.ts`       | `createTestUser()`, `createTestOrg()`, `createTestContext()` |
| `db.ts`         | `truncateAll()` -- DELETE FROM all tables in FK-safe order   |
| `seed.ts`       | 15+ factories: `seedPackage()`, `seedRun()`, etc.            |
| `assertions.ts` | `assertDbHas()`, `assertDbMissing()`, `assertDbCount()`      |
| `redis.ts`      | `getRedis()`, `flushRedis()`                                 |

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

## Workspace Imports

Import from workspace packages using their published subpaths:

- `@appstrate/core/*` -- validation, zip, naming, dependencies, integrity, semver, logger, storage, etc.
- `@appstrate/db/schema` -- Drizzle schema. **Every** table lives here, including the ones a module reads/writes (`schema/oidc.ts`, `schema/webhooks.ts`, …). Modules own no schema, no migrations, no `schema.ts` of their own
- `@appstrate/db/client` -- `db` + `listenClient`
- `@appstrate/env` -- `getEnv()` (Zod-validated, cached, fail-fast)
- `@appstrate/connect` -- OAuth2/PKCE, credential encryption (v1 envelope + multi-key keyring)
- `@appstrate/afps-runtime` -- portable bundle loader + signing + sinks + Pi runner
- `@appstrate/mcp-transport` -- MCP SDK adapter (createMcpServer, createInProcessPair, createMcpHttpClient)
- `@appstrate/shared-types` -- Drizzle InferSelectModel re-exports
- `@appstrate/emails` -- Email template rendering

## Environment Variables

**Do not copy an env table into this file.** Every hand-maintained copy of the
env contract in this repo has drifted from the schema; the generator is
authoritative and cheap to read:

| Source                      | What it is                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/env/src/index.ts` | **Authoritative** — the Zod schema. Names, defaults, refinements, required-ness. Wins on any conflict.                                            |
| `docs/ENV.md`               | Prose reference — one row per var, plus the handful of sidecar/module vars read straight from `process.env` and therefore absent from the schema. |
| `.env.example`              | Operator contract — dev-ready values, commented by default.                                                                                       |

Boot fails without: `BETTER_AUTH_SECRET`, `CONNECTION_ENCRYPTION_KEY`,
`UPLOAD_SIGNING_SECRET`, `RUN_TOKEN_SECRET`, `CONNECT_SESSION_SECRET`.
Everything else has a schema default. To list the current key set:

```sh
grep -oE '^    [A-Z][A-Z0-9_]*:' packages/env/src/index.ts | tr -d ' :' | sort
```

`MODULES` is the var most often mis-quoted from memory — read its `.default(...)`
in the schema rather than trusting any doc (including this one).
