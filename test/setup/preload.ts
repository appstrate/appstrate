/**
 * Test preload script — runs once before any test file.
 *
 * 1. Starts test containers (PostgreSQL + Redis + MinIO + DinD) if not already running
 * 2. Sets environment variables for the test database and Redis
 * 3. Runs Drizzle migrations against the test database (core + all modules)
 * 4. Registers module-owned tables for truncation
 *
 * Module discovery — two roots:
 *   - apps/api/src/modules/<name>/ (built-in modules, entry: index.ts)
 *   - packages/module-<name>/ (workspace-package modules, entry: src/index.ts)
 *
 * Each module directory contributes:
 *   - the entry file — default-exports an AppstrateModule (used by getTestApp)
 *   - drizzle/migrations/NNNN_name.sql — applied in file-name order (alphabetical)
 *   - test/tables.ts — default-exports a string[] of tables for truncateAll()
 *
 * All three are optional. Running core tests alone still picks up installed
 * modules because anything in either root is part of the repo — there is no
 * "module disabled" state in tests, unlike production (MODULES env var).
 */
import { resolve, join } from "path";
import { readdirSync, existsSync, statSync } from "fs";
import type { AppstrateModule } from "@appstrate/core/module";
import { applyModuleMigration } from "./apply-module-migration.ts";
import {
  TEST_DB_NAME,
  TEST_DB_USER,
  TEST_MINIO_CONTAINER,
  TEST_POSTGRES_CONTAINER,
} from "./constants.ts";

// ─── Docker Compose (idempotent — no-op if already running) ─────
const composeFile = resolve(import.meta.dir, "docker-compose.test.yml");
const compose = Bun.spawnSync(["docker", "compose", "-f", composeFile, "up", "-d", "--wait"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (compose.exitCode !== 0) {
  const stderr = compose.stderr.toString();
  throw new Error(`Docker Compose failed (exit ${compose.exitCode}): ${stderr}`);
}

// ─── Environment ────────────────────────────────────────────
// Set test env vars BEFORE any module that calls getEnv() is imported.
// Bun preload runs before test files, so getEnv() will pick these up.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:5433/appstrate_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

// Override production env vars with test values
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long-for-hmac";
process.env.UPLOAD_SIGNING_SECRET = "test-upload-signing-secret-at-least-16-chars";
process.env.CONNECTION_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
); // 32 bytes
process.env.S3_BUCKET = "test-bucket";
process.env.S3_REGION = "us-east-1";
// Port 9012 mirrors the MinIO host-port mapping in docker-compose.test.yml
// (kept off 9000/9002 to avoid colliding with other dev servers on the host).
process.env.S3_ENDPOINT = "http://localhost:9012";
process.env.AWS_ACCESS_KEY_ID = "minioadmin";
process.env.AWS_SECRET_ACCESS_KEY = "minioadmin";
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_ORIGINS = "http://localhost:3000";
process.env.LOG_LEVEL = "error"; // Suppress logs during tests

// Disable email verification in tests (SMTP vars from .env would enable it)
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;

// Disable Google social auth in tests
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
process.env.SIDECAR_POOL_SIZE = "0"; // Disable sidecar pool in tests
process.env.DOCKER_SOCKET = "http://localhost:2375";

// Belt-and-suspenders: when `bun test` runs from the monorepo root, the
// CLI's own bunfig preload (which sets these) is ignored in favour of this
// one. Without them, tests launched from a real terminal (not CI) inherit
// isTTY=true and diverge: login pops real browser tabs, openapi emits ANSI
// colors the snapshots don't expect, and the non-TTY prompt guards block
// waiting for input. Force non-TTY + no-color + no-open so bun:test behaves
// identically whether launched from a TTY shell or CI.
process.env.APPSTRATE_CLI_NO_OPEN = "1";
process.env.NO_COLOR = "1";
Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });

// ─── MinIO bucket creation ───────────────────────────────────
// Create the test bucket via mc inside the MinIO container (idempotent).
const mcAlias = Bun.spawnSync(
  [
    "docker",
    "exec",
    TEST_MINIO_CONTAINER,
    "mc",
    "alias",
    "set",
    "local",
    "http://localhost:9000",
    "minioadmin",
    "minioadmin",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
if (mcAlias.exitCode === 0) {
  Bun.spawnSync(
    ["docker", "exec", TEST_MINIO_CONTAINER, "mc", "mb", "--ignore-existing", "local/test-bucket"],
    { stdout: "pipe", stderr: "pipe" },
  );
}

// ─── DinD: pre-pull alpine image ─────────────────────────────
// Pull alpine:3.20 into the DinD daemon so docker API tests don't wait for pulls.
Bun.spawnSync(["docker", "-H", "tcp://localhost:2375", "pull", "alpine:3.20"], {
  stdout: "pipe",
  stderr: "pipe",
});

// ─── Migrations ─────────────────────────────────────────────
// Drop and recreate the test DB to ensure a clean slate (fresh migration).
// Uses psql via the test postgres container to avoid needing a local client.
function psqlAdmin(sqlCommand: string): void {
  Bun.spawnSync(
    [
      "docker",
      "exec",
      TEST_POSTGRES_CONTAINER,
      "psql",
      "-U",
      TEST_DB_USER,
      "-d",
      "postgres",
      "-c",
      sqlCommand,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
}

psqlAdmin(
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid();`,
);
psqlAdmin(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`);
psqlAdmin(`CREATE DATABASE ${TEST_DB_NAME};`);

// Run drizzle-kit migrate as a subprocess from the packages/db directory,
// since the postgres driver is a dependency of @appstrate/db, not @appstrate/api.

const dbDir = resolve(import.meta.dir, "../../packages/db");
const result = Bun.spawnSync(["bun", "drizzle-kit", "migrate"], {
  cwd: dbDir,
  env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  stdout: "pipe",
  stderr: "pipe",
});

if (result.exitCode !== 0) {
  const stderr = result.stderr.toString();
  const stdout = result.stdout.toString();
  throw new Error(
    `Migration failed (exit ${result.exitCode}):\nstderr: ${stderr}\nstdout: ${stdout}`,
  );
}

// ─── Module migrations + truncation registration ────────────
// Auto-discover every module in the repo and wire up its test infrastructure.
// We do this from the root preload (not per-module) so that `bun test` from
// any directory sees a consistent state.
//
// Two layouts are recognised:
//   - apps/api/src/modules/<name>/index.ts (built-in modules)
//   - packages/module-<name>/src/index.ts (workspace-package modules)
// Both share the same `drizzle/migrations/` and `test/tables.ts` conventions
// (relative to the module's root directory).

interface DiscoveredModule {
  /** Module root directory. */
  dir: string;
  /** Absolute path to the module's entry file. */
  entry: string;
}

function discoverModules(
  root: string,
  entryRel: string,
  dirPredicate: (name: string) => boolean = () => true,
): DiscoveredModule[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter(dirPredicate)
    .map((name) => ({ dir: join(root, name), entry: join(root, name, entryRel) }))
    .filter(({ dir, entry }) => statSync(dir).isDirectory() && existsSync(entry));
}

const builtinModulesRoot = resolve(import.meta.dir, "../../apps/api/src/modules");
const workspaceModulesRoot = resolve(import.meta.dir, "../../packages");
const moduleEntries: DiscoveredModule[] = [
  // Built-in modules — `apps/api/src/modules/<name>/index.ts`.
  ...discoverModules(builtinModulesRoot, "index.ts"),
  // Workspace-package modules — `packages/module-<name>/src/index.ts`.
  // The `module-` prefix is the convention that distinguishes module
  // workspace packages from regular library packages (core, db, ui, …).
  ...discoverModules(workspaceModulesRoot, "src/index.ts", (n) => n.startsWith("module-")),
];

for (const { dir: moduleDir } of moduleEntries) {
  const migrationsDir = join(moduleDir, "drizzle", "migrations");
  if (!existsSync(migrationsDir)) continue;
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const sqlFile of sqlFiles) {
    applyModuleMigration(join(migrationsDir, sqlFile));
  }
}

// Dynamic imports are async — bun supports top-level await in preloads.
const { registerTruncationTables } = await import("../../apps/api/test/helpers/db.ts");
const { registerTestModule } = await import("../../apps/api/test/helpers/test-modules.ts");

// `portkey` is mandatory in production: `boot.ts` aborts if the router
// slots are empty AND request-time code requires the router to return a
// non-null routing tuple for every api_key call. Tests don't run module
// `init()` (no real gateway sub-process), so install a passthrough mock
// that delegates to the production `buildPortkeyRouting()` against a
// loopback gateway host. This keeps the test routing math in lockstep
// with prod — there is no second per-shape prefix table to drift.
// Individual tests can override these to exercise specific edge cases.
const { setPortkeyRouter, setPortkeyInprocessRouter } =
  await import("../../apps/api/src/services/portkey-router.ts");
const { buildPortkeyRouting } = await import("../../apps/api/src/modules/portkey/config.ts");
function buildTestRouter(host: string) {
  return (model: { apiShape: string; baseUrl: string; apiKey: string }) =>
    buildPortkeyRouting(model, host);
}
setPortkeyRouter(buildTestRouter("http://host.docker.internal:8787"));
setPortkeyInprocessRouter(buildTestRouter("http://127.0.0.1:8787"));

// Phase 1: discover modules and register them. We collect imported modules
// into a local list, then use the shared `collectModuleContributions()`
// helper from module-loader.ts to aggregate Better Auth plugins + Drizzle
// schemas in one place — the production boot path uses the same helper
// (via `getModuleContributions()`), so tests and prod cannot drift.
const importedModules: AppstrateModule[] = [];

for (const { dir: moduleDir, entry: indexFile } of moduleEntries) {
  // Register the module itself so getTestApp() can mount its router
  const imported: { default?: AppstrateModule } = await import(indexFile);
  if (imported.default) {
    registerTestModule(imported.default);
    importedModules.push(imported.default);
  }

  // Register its tables for per-test truncation
  const tablesFile = join(moduleDir, "test", "tables.ts");
  if (!existsSync(tablesFile)) continue;
  const tables: { default?: readonly string[] } = await import(tablesFile);
  if (tables.default) {
    registerTruncationTables(tables.default);
  } else {
    throw new Error(
      `${tablesFile} must default-export a readonly string[] of tables (children first, FK-safe).`,
    );
  }
}

// Phase 2: initialize Better Auth singleton with every module's plugins.
// The production code path calls createAuth() from boot.ts after
// loadModules(); tests don't go through boot(), so we initialize directly
// here. `collectModuleContributions()` is the shared aggregator used by
// both paths — types flow through as `BetterAuthPluginList`, no `never`
// cast needed at this layer. Subsequent `getTestApp({ modules })` calls
// reuse this singleton so strategy tests and E2E OAuth flow tests see a
// coherent auth surface with no double-initialization cost.
const { collectModuleContributions, emitEvent } =
  await import("../../apps/api/src/lib/modules/module-loader.ts");
const { createAuth, setPostBootstrapOrgHook } = await import("../../packages/db/src/auth.ts");
const contributions = collectModuleContributions(importedModules);
createAuth(
  contributions.betterAuthPlugins as Parameters<typeof createAuth>[0],
  contributions.drizzleSchemas,
);

// Mirror the production post-bootstrap wiring (boot.ts) so the bootstrap
// after-hook does the same provisioning under test as it does in prod.
// Without this, the bootstrap test would only ever see the org row — the
// default app + hello-world agent + onOrgCreate emit (issue #228) would
// never run in CI, and any regression in that wiring would slip past us.
const { createDefaultApplication } = await import("../../apps/api/src/services/applications.ts");
const { provisionDefaultAgentForOrg } =
  await import("../../apps/api/src/services/default-agent.ts");
setPostBootstrapOrgHook(async ({ orgId, slug, userId, userEmail }) => {
  await emitEvent("onOrgCreate", orgId, userEmail);
  const defaultApp = await createDefaultApplication(orgId, userId).catch(() => null);
  if (defaultApp) {
    await provisionDefaultAgentForOrg(orgId, slug, userId, defaultApp.id).catch(() => {});
  }
});

// ─── Global auto-reset for RBAC audit handler ─────────────────
// `setPermissionDenialHandler` writes a module-level singleton inside
// `@appstrate/core/permissions`. A test that installs a custom handler
// and forgets to clean up would leak it into every subsequent test file
// in the same process — `bun test` runs the full suite as a single
// process (see the "Testing" header in CLAUDE.md). Reset after every
// test so no test needs to remember an `afterEach` of its own.
//
// Registering through a dynamic import avoids coupling this preload to
// the core types at top-level, and lets us tolerate the (already
// unlikely) case where the module fails to resolve — we log and move on
// rather than blocking the whole suite.
const { afterEach } = await import("bun:test");
const { setPermissionDenialHandler } = await import("@appstrate/core/permissions");
afterEach(() => {
  setPermissionDenialHandler(null);
});
