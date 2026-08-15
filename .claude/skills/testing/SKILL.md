---
name: testing
description: How to run and write tests in the Appstrate monorepo — bun:test commands and tiers (Docker services, DinD opt-in via TEST_DOCKER=1, Tier-0 PGlite path), the bunfig.toml preload that auto-discovers built-in and workspace modules, test directory layout, naming and isolation conventions, the zero-footprint invariant, and the test helpers (getTestApp, authHeaders, truncateAll, seed factories, SSE and OAuth mocks). Use when running the suite, adding a test, adding a module's test wiring, or debugging test setup and DB isolation. The no-mock.module() rule lives in the root CLAUDE.md and always applies.
---

# Testing

```sh
bun test                          # Full suite — core + every module, single process
bun test apps/api/test            # Core only
bun test apps/api/src/modules     # All modules
bun run test:unit                 # API unit tests only (no DB)
bun run test:e2e                  # Playwright e2e suite
bun run test:docker               # Include slow Docker-engine (DinD) tests (TEST_DOCKER=1)
cd apps/api/src/modules/webhooks && bun test   # Per-module (own bunfig.toml)
```

Requires Docker (PostgreSQL :5433, Redis :6380, MinIO :9012, DinD :2375 — started automatically by preload). DinD-dependent tests skip by default locally — opt in with `TEST_DOCKER=1` (or `bun run test:docker`); they always run when `CI=true` (GitHub Actions). Third-party CI that sets `CI=1` must set `TEST_DOCKER=1` explicitly (the tier helper warns). The Tier-0 path (`TEST_TIER=0`, `bun run test:tier0`) runs against PGlite with no Docker.

## Configuration

Single root `bunfig.toml` drives core tests; each module has its own pointing at the same root preload. Root preload (`test/setup/preload.ts`) runs Docker Compose, sets env, applies core migrations, then auto-discovers built-in modules (`apps/api/src/modules/*/`) **and** workspace modules (`packages/module-*/src/`) and wires:

- `drizzle/migrations/*.sql` → applied alphabetically via `apply-module-migration.ts`
- `index.ts` → dynamic-imported, registered in `test-modules.ts` for `getTestApp()`
- `test/tables.ts` → `string[]` registered via `registerTruncationTables()`

Adding a built-in module is mechanical: drop directory with `index.ts`, `drizzle/migrations/`, `test/tables.ts`. No edits to core test infra.

**Zero-footprint invariant**: core tests have zero knowledge of any module. `getTestApp()` takes optional `{ modules }` — core calls with none, module helpers pass their own. Cross-module behavior covered by e2e, not by loading multiple modules in one process.

## Conventions

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

Instead of `mock.module()` (banned, see root `CLAUDE.md`), use dependency injection: optional `deps` parameter with production defaults, constructor injection, or function-parameter injection (runtime-pi pattern). For middleware that calls services (e.g. `requireAgent` → `getPackage`), use integration tests with real DB instead of mocking the service layer.

## Helpers (`apps/api/test/helpers/`)

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
