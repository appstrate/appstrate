---
name: testing
description: How to run and write tests in the Appstrate monorepo — bun:test commands and tiers (Docker services, DinD opt-in via TEST_DOCKER=1, Tier-0 PGlite path), the bunfig.toml preload that auto-discovers built-in and workspace modules, test directory layout, naming and isolation conventions, the zero-footprint invariant, and the test helpers (getTestApp, authHeaders, truncateAll, seed factories, SSE and OAuth mocks). Use when running the suite, adding a test, adding a module's test wiring, or debugging test setup and DB isolation. The no-mock.module() rule lives in the root AGENTS.md and always applies.
---

# Testing

```sh
bun run test:tier0                # Full suite on PGlite, split across processes — the fast local run
bun run test:tier0 apps/api/test  # Same, filtered (a path substring, as `bun test` takes it)
bun test                          # Full suite — core + every module, single process
bun test apps/api/test            # Core only
bun test apps/api/src/modules     # All modules
bun run test:unit                 # API unit tests only (no DB)
bun run test:e2e                  # Playwright e2e suite
bun run test:docker               # Include slow Docker-engine (DinD) tests (TEST_DOCKER=1)
cd apps/api/src/modules/webhooks && bun test   # Per-module (own bunfig.toml)
```

Requires Docker (PostgreSQL :5433, Redis :6380, MinIO :9012, DinD :2375 — started automatically by preload). DinD-dependent tests skip by default locally — opt in with `TEST_DOCKER=1` (or `bun run test:docker`); they always run when `CI=true` (GitHub Actions). Third-party CI that sets `CI=1` must set `TEST_DOCKER=1` explicitly (the tier helper warns). The Tier-0 path (`TEST_TIER=0`, `bun run test:tier0`) runs against PGlite with no Docker.

`bun run test:tier0` is `scripts/run-tests.ts`: it collects the test files git knows (tracked, plus untracked-but-not-ignored — scratch dirs and nested worktrees stay out), deals them to several `bun test` processes by their measured duration (`node_modules/.cache/appstrate-test/timings.json`, refreshed by every run), and prints each process's output then one summary. Tier 0 is what makes that safe — every process gets its own PGlite directory, storage directory and in-memory infra. `--shards=N` (or `APPSTRATE_TEST_SHARDS`) sets the process count, `--shards=1` streams live. Tier 3 shares one PostgreSQL/Redis/MinIO, so the runner refuses more than one process there; CI splits tier 3 across machines with `--partition=I/K` instead (`.github/workflows/test.yml`).

**Fixed cost per process.** The tier-0 preload seeds its PGlite directory from a cached dump of the migrated database (`apps/api/test/helpers/journal.ts` → `journalDump`, keyed on the migration files, the PGlite build and the builder code), so a process starts in ~4 s instead of ~10 s; the first run after a migration change rebuilds the dump. Migration tests that need the journal replayed up to a tag get a fresh in-memory database from the same cache with `journalPGlite({ through })` — never `new PGlite()` + a replay.

**Per-test timeout: 15 s** under `scripts/run-tests.ts` and in `.github/workflows/test.yml` (10 s for `apps/cli` there), passed as `--timeout` — the only setting that holds for every file: bunfig has no timeout key (a `[test] timeout` there is silently ignored), and `setDefaultTimeout()` in a preload holds for the first file only. A plain `bun test` runs under Bun's own 5 s; a test that needs more than that states its own.

## Configuration

Single root `bunfig.toml` drives core tests; each module has its own pointing at the same root preload. Root preload (`test/setup/preload.ts`) refuses a Bun that does not satisfy the root `engines.bun` (the version CI pins), runs Docker Compose, sets env, applies core migrations, then auto-discovers built-in modules (`apps/api/src/modules/*/`) **and** workspace modules (`packages/module-*/src/`) and wires:

- `index.ts` → dynamic-imported, registered in `test-modules.ts` for `getTestApp()`
- `test/tables.ts` → `string[]` registered via `registerTruncationTables()`
- `test/requirements.ts` → `{ postgres?: boolean; env?: Record<string, string> }`. `env` is applied with `Object.assign` before the module entry is imported, so it OVERRIDES the ambient environment on purpose — the suite truncates and drops the tables it is pointed at, and a developer `.env` (Bun auto-loads it) may name a real database; `postgres: true` means the module is not imported, not initialized, and its own test files are not collected under `bun run test:tier0` (`scripts/run-tests.ts` derives the exclusion from the same file — see `test/setup/modules.ts`)

There is no per-module migration step: **modules own no tables**, so a module's tables are created by the core migration step above. `apps/api/src/modules/README.md` ("Database ownership rules") owns that rule and the reasoning behind it.

Adding a built-in module is mechanical: drop a directory with `index.ts` and `test/tables.ts`. No edits to core test infra.

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

Instead of `mock.module()` (banned, see root `AGENTS.md`), use dependency injection: optional `deps` parameter with production defaults, constructor injection, or function-parameter injection (runtime-pi pattern). For middleware that calls services (e.g. `requireAgent` → `getPackage`), use integration tests with real DB instead of mocking the service layer.

## Helpers (`apps/api/test/helpers/`)

| Helper              | Purpose                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`            | `getTestApp()` — full Hono replica (production middleware chain, no boot/Docker/scheduler)                                                            |
| `auth.ts`           | `createTestUser/Org/Context()`, `authHeaders()`, `orgOnlyHeaders()` — real Better Auth sign-up. `authHeaders()` auto-injects `X-Space-Id`             |
| `db.ts`             | `truncateAll()` — DELETE FROM all tables in FK-safe order                                                                                             |
| `seed.ts`           | Factories: `seedPackage()`, `seedInstalledPackage()`, `seedRun()`, `seedApiKey()`, `seedSpace()`, `seedEndUser()`, … (space-scoped require `spaceId`) |
| `assertions.ts`     | `assertDbHas/Missing/Count()`, `getDbRow()`                                                                                                           |
| `redis.ts`          | `flushRedis()`, `closeRedis()`                                                                                                                        |
| `sse.ts`            | SSE stream parsing                                                                                                                                    |
| `oauth-server.ts`   | Mock OAuth2 provider                                                                                                                                  |
| `run-logs-fault.ts` | `failRunLogsInsert()` / `clearRunLogsFault()` — trigger that fails `run_logs` INSERTs with a chosen SQLSTATE                                          |

To write a new test, copy the nearest existing one in the matching directory (unit = pure, integration = `getTestApp()` + `truncateAll()` + `createTestContext()`).
