# Appstrate — AI Agent Instructions

Appstrate is an open-source platform for running autonomous AI agents in sandboxed Docker containers. Users connect providers (Gmail, ClickUp, etc.), configure agents, and let AI agents process their data autonomously.

## Build & Development

| Command                  | Description                                                         |
| ------------------------ | ------------------------------------------------------------------- |
| `bun install`            | Install dependencies (use `--frozen-lockfile` in CI)                |
| `bun run dev`            | Start API (:3000) + Vite build --watch (turborepo)                  |
| `bun test`               | Run all tests (~4500, bun:test framework, requires Docker)          |
| `bun run check`          | TypeScript + ESLint + Prettier + OpenAPI validation (258 endpoints) |
| `bun run build`          | Build everything (turbo build)                                      |
| `bun run db:generate`    | Generate Drizzle migrations from schema changes                     |
| `bun run db:migrate`     | Apply migrations to PostgreSQL                                      |
| `bun run verify:openapi` | Validate OpenAPI spec (structural + lint, 0 errors required)        |

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
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL, Redis, MinIO
bun run db:migrate
bun run build
bun run dev
```

## Code Conventions

- **TypeScript strict mode**, no build step for backend (Bun resolves `.ts` directly)
- **No `console.*`** -- use `@appstrate/core/logger` (pino JSON to stdout)
- **No Node APIs** -- use Bun equivalents (`Bun.CryptoHasher`, `Bun.file`, etc.)
- **French UI text** via i18next (`fr` default, `en`), English code/comments
- **Conventional Commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- **Zod 4** for all request body/query validation (NOT Zod 3). Use `z.url()` not `z.string().url()`
- **AJV** only for dynamic manifest schemas (agent config/input/output from user-defined manifests)
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
│   │   ├── modules/          # Built-in modules (oidc, webhooks) -- owned schemas + routes + RBAC
│   │   ├── openapi/          # OpenAPI 3.1 spec (source of truth, 258 endpoints)
│   │   └── middleware/       # Auth, rate-limit, guards
│   ├── cli/                  # @appstrate/cli -- channel-aware install + self-update + doctor
│   └── web/src/              # React 19 SPA (Vite + React Query v5 + Zustand)
│       ├── pages/            # Route pages (React Router v7)
│       ├── hooks/            # React Query + SSE realtime hooks
│       ├── components/       # UI components
│       └── stores/           # Zustand stores (auth, org, profile)
├── packages/
│   ├── core/                 # @appstrate/core -- shared validation, storage, utilities
│   ├── ui/                   # @appstrate/ui -- React components (schema-form, widgets) published to npm
│   ├── afps-runtime/         # @appstrate/afps-runtime -- portable AFPS bundle runner + signing + conformance + `afps` CLI
│   ├── mcp-transport/        # @appstrate/mcp-transport -- MCP SDK adapter consumed by sidecar + runtime-pi
│   ├── db/                   # @appstrate/db -- Drizzle ORM + Better Auth
│   ├── env/                  # @appstrate/env -- Zod env validation (authoritative source)
│   ├── emails/               # @appstrate/emails -- Email templates + rendering
│   ├── shared-types/         # @appstrate/shared-types -- Drizzle InferSelectModel re-exports
│   └── connect/              # @appstrate/connect -- OAuth2/PKCE, API key, credential encryption (v1 envelope + multi-key keyring)
├── runtime-pi/               # Docker image: Pi Coding Agent SDK + sidecar (MCP server) -- 313 MB slim
└── system-packages/          # System package ZIPs (providers, skills, tools, agents)
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

- **OpenAPI specs** in `apps/api/src/openapi/` are the source of truth (258 endpoints — verified by `bun run verify:openapi`)
- New route: create route file in `routes/` + OpenAPI path in `openapi/paths/` + wire in `index.ts`
- All route bodies validated with `parseBody(schema, body)` from `lib/errors.ts`
- Error responses follow RFC 9457 `application/problem+json`
- `Request-Id` (`req_` prefix) on all responses

### Database

- **No RLS** -- all queries filter by `orgId` at the application level (multi-tenant)
- Schema: `packages/db/src/schema.ts` (31 tables, 5 enums)
- Migrations: edit schema.ts -> `bun run db:generate` -> `bun run db:migrate`
- Service layer: function-based (no classes), `state.ts` is central data-access layer

### Backend Patterns

- No build step: backend ships as `.ts`, Bun resolves directly
- Logging: `lib/logger.ts` (pino JSON) -- never `console.*`
- Auth: Better Auth cookie sessions + `X-Org-Id` header for org context
- API key auth (`ask_*` prefix) tried first, then cookie fallback
- Request pipeline: error handler -> Request-Id -> CORS -> health -> auth -> org context -> routes
- Route guards: `requireAdmin()`, `requireOwner()`, `requireAgent()`, `requireMutableAgent()`
- Rate limiting: Redis-backed, keyed by `method:path:identity`

### Frontend Patterns

- i18next: `fr` (default) + `en`, namespaces: `common`, `agents`, `settings`
- API helpers in `api.ts`: `api<T>(path)` prepends `/api`, injects `X-Org-Id`, `credentials: "include"`
- React Query keys: org-scoped `[entity, orgId, id?]`
- Feature gating: `useAppConfig()` reads `window.__APP_CONFIG__` (injected at boot)
- Always use `<Modal>` from `components/modal.tsx` for dialogs

### Docker Integration

- Docker client: `fetch()` + unix socket -- NOT dockerode (socket bugs with Bun)
- Sidecar pool: pre-warmed containers for fast startup
- Credential isolation: agent calls sidecar proxy, never sees raw credentials
- Multiplexed stream headers: `[stream_type(1), 0(3), size(4)]` parsed in `streamLogs()`

### Agent runtime — MCP-only

- The sidecar exposes `/mcp` (Streamable HTTP, stateless JSON-RPC) as the agent's exclusive cross-boundary surface
- Four canonical first-party tools registered as Pi tools at container boot (`runtime-pi/extensions/mcp-direct.ts`):
  - `provider_call({ providerId, method, target, headers?, body?, responseMode? })` — credential-injecting proxy
  - `run_history({ limit?, fields? })` — past-run metadata via per-run signed token
  - `llm_complete(...)` — platform-configured LLM passthrough exposed as a tool
  - `recall_memory({ scope?, key? })` — read the unified `package_persistence` archive (replaces the legacy memory-as-prompt-section model)
- Zero-knowledge enforcement: after MCP bootstrap, `runtime-pi` deletes `process.env.SIDECAR_URL` so the bash extension cannot discover the sidecar
- The legacy HTTP `/proxy` and `/run-history` routes are fully retired — runners 1.x are not compatible

### Memory model — `note` / `pin` / `recall_memory` (ADR-011/012/013)

- Single `package_persistence` table with `(actor_type, actor_id)` scope (`member` / `end_user` / `shared`) and orthogonal `(key, pinned)` attributes
- Three quadrants: archive (key=null, pinned=false), pinned memo (key=null, pinned=true), pinned named slot (key=string, pinned=true)
- Write tools: `note(content, scope?)` (system tool `@appstrate/note@1.0.0`), `pin(key, content, scope?)` (system tool `@appstrate/pin@1.0.0`)
- Legacy `add-memory` / `set-checkpoint` system tools are retired; `runs.state` + `package_memories` are merged into `package_persistence`
- Wire format: `RunResult.pinned: Record<string, PinnedSlot>` (top-level `RunResult.checkpoint` mirror was dropped)

### AFPS bundle runtime — `@appstrate/afps-runtime`

- Portable bundle runner (`packages/afps-runtime/`, 64 TS files) drives the platform's run pipeline and ships a standalone `afps` CLI: `run` / `test` / `sign` / `verify` / `keygen` / `inspect` / `render`
- Multi-package `.afps-bundle` format with Merkle-root integrity (per-file RECORD SRI → per-package SRI → bundle-level SRI on canonical map)
- Endpoints: `GET /api/agents/:scope/:name/bundle` (export) + `POST /api/packages/import-bundle` (accepts `.afps-bundle` and legacy `.afps`)
- Signature policy via `AFPS_SIGNATURE_POLICY` env (`off` | `warn` | `required`) and `AFPS_TRUST_ROOT` allowlist

## Testing

### Running Tests

```sh
bun test                          # All ~4500 tests, requires Docker
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
- `@appstrate/db/schema` -- Drizzle schema (core tables; module-owned tables live in `apps/api/src/modules/<name>/schema.ts`)
- `@appstrate/db/client` -- `db` + `listenClient`
- `@appstrate/env` -- `getEnv()` (Zod-validated, cached, fail-fast)
- `@appstrate/connect` -- OAuth2/PKCE, credential encryption (v1 envelope + multi-key keyring)
- `@appstrate/afps-runtime` -- portable bundle loader + signing + sinks + Pi runner
- `@appstrate/mcp-transport` -- MCP SDK adapter (createMcpServer, createInProcessPair, createMcpHttpClient)
- `@appstrate/shared-types` -- Drizzle InferSelectModel re-exports
- `@appstrate/emails` -- Email template rendering

## Key Environment Variables

| Variable                         | Required | Description                                                                              |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | No       | PostgreSQL connection. Absent = PGlite (embedded)                                        |
| `BETTER_AUTH_SECRET`             | Yes      | Session signing secret                                                                   |
| `UPLOAD_SIGNING_SECRET`          | Yes      | HMAC secret for FS upload-sink tokens (rotates independently of `BETTER_AUTH_SECRET`)    |
| `CONNECTION_ENCRYPTION_KEY`      | Yes      | 32 bytes base64, primary key for v1 credential envelope                                  |
| `CONNECTION_ENCRYPTION_KEY_ID`   | No       | Active kid embedded in newly-encrypted blobs (default `k1`)                              |
| `CONNECTION_ENCRYPTION_KEYS`     | No       | JSON map `{ kid: base64-32B-key }` of retired keys held for decrypt-only during rotation |
| `REDIS_URL`                      | No       | Redis connection. Absent = in-memory adapters (single-instance)                          |
| `S3_BUCKET`                      | No       | S3 bucket. Absent = filesystem storage (`FS_STORAGE_PATH`)                               |
| `S3_REGION`                      | No       | S3 region. Required when `S3_BUCKET` is set                                              |
| `APP_URL`                        | No       | Public URL (default: `http://localhost:3000`)                                            |
| `PORT`                           | No       | Server port (default: `3000`)                                                            |
| `LOG_LEVEL`                      | No       | `debug` / `info` / `warn` / `error`                                                      |
| `MODULES`                        | No       | Comma-separated module specifiers (default: `oidc,webhooks`)                             |
| `AUTH_DISABLE_SIGNUP`            | No       | Closed-mode lock; see `examples/self-hosting/AUTH_MODES.md` for the 6 `AUTH_*` vars      |
| `SIDECAR_MAX_REQUEST_BODY_BYTES` | No       | Sidecar inbound POST size cap (default 10 MB; hard ceiling 100 MB)                       |
| `SIDECAR_MAX_MCP_ENVELOPE_BYTES` | No       | MCP envelope cap, sized for base64 inflation (default 16 MB)                             |
| `AFPS_SIGNATURE_POLICY`          | No       | `off` (default) / `warn` / `required` for `.afps-bundle` Ed25519 verification            |

Full list (~70 vars): `packages/env/src/index.ts` (authoritative Zod schema). See `README.md` and `CLAUDE.md` for the full table including remote runner protocol, watchdog, AFPS signing, OIDC instance clients, run limits, and SMTP.
