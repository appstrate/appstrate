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
import { readdirSync, existsSync, statSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import type { AppstrateModule } from "@appstrate/core/module";
import {
  TEST_DB_NAME,
  TEST_DB_USER,
  TEST_MINIO_CONTAINER,
  TEST_POSTGRES_CONTAINER,
} from "./constants.ts";

// ─── Tier selection ─────────────────────────────────────────
// tier0 (TEST_TIER=0): fast in-memory dev mode — PGlite (throwaway temp dir),
// in-memory infra adapters (no Redis), filesystem storage (no S3/MinIO), and
// no Docker/DinD. tier3 (default, CI): real PostgreSQL + Redis + MinIO + DinD
// via docker-compose, exactly as before.
const TIER0 = process.env.TEST_TIER === "0";

// ─── Docker Compose (idempotent — no-op if already running) ─────
// tier3 only — tier0 needs no external services.
if (!TIER0) {
  const composeFile = resolve(import.meta.dir, "docker-compose.test.yml");
  const compose = Bun.spawnSync(["docker", "compose", "-f", composeFile, "up", "-d", "--wait"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (compose.exitCode !== 0) {
    const stderr = compose.stderr.toString();
    throw new Error(`Docker Compose failed (exit ${compose.exitCode}): ${stderr}`);
  }
}

// ─── Environment ────────────────────────────────────────────
// Set test env vars BEFORE any module that calls getEnv() is imported.
// Bun preload runs before test files, so getEnv() will pick these up.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:5433/appstrate_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6380";

// Secrets + app config — required in every tier.
process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long-for-hmac";
process.env.UPLOAD_SIGNING_SECRET = "test-upload-signing-secret-at-least-16-chars";
process.env.RUN_TOKEN_SECRET = "test-run-token-secret-at-least-16-chars";
process.env.CONNECT_SESSION_SECRET = "test-connect-session-secret-at-least-16-chars";
process.env.CONNECTION_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
); // 32 bytes
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_ORIGINS = "http://localhost:3000";
process.env.LOG_LEVEL = "error"; // Suppress logs during tests
// Swap Better Auth's scrypt hasher (~35ms/hash) for a plain SHA-256 in tests —
// most tests sign up a real user per beforeEach, so scrypt dominates the run.
// Round-trip semantics are unchanged, so auth coverage is preserved. NEVER set
// in production.
process.env.AUTH_FAST_TEST_HASH = "1";
// Shrink the out-of-order event buffer flush window (prod default 5s). Tests
// that wait on a non-terminal event flush would otherwise pay up to 5s each;
// 50ms keeps ordering semantics intact while removing the dead wait.
process.env.REMOTE_RUN_BUFFER_FLUSH_MS = process.env.REMOTE_RUN_BUFFER_FLUSH_MS ?? "50";
// Shrink the run-wait fallback DB poll cadence (prod default 2s). Long-poll
// tests that flip a run mid-wait would otherwise pay up to 2s per wakeup when
// the NOTIFY path doesn't deliver; 50ms keeps the hold-then-release semantics
// intact while removing the dead wait.
process.env.RUN_WAIT_POLL_INTERVAL_MS = process.env.RUN_WAIT_POLL_INTERVAL_MS ?? "50";
// The OAuth egress + remote-integration SSRF guards now resolve DNS and fail
// closed. The integration suite points token/refresh endpoints at non-resolvable
// test hosts (`auth.example.test`) and real loopback `Bun.serve` instances
// (`127.0.0.1`/`localhost`), and the remote-spawn tests use `mcp.example.com` —
// all benign fixtures that the guard would (correctly, in prod) block. Reuse the
// operator internal-host allowlist to exempt exactly those fixture hosts for the
// test run; production leaves it unset so every host stays guarded. NEVER set
// these hosts in production.
process.env.OAUTH_ALLOWED_INTERNAL_IDP_HOSTS =
  process.env.OAUTH_ALLOWED_INTERNAL_IDP_HOSTS ??
  "auth.example.test,127.0.0.1,localhost,mcp.example.com,api.openai.test,api.anthropic.test,api.mistral.test,api.example.com,intranet.corp,mcp-norefresh.example,mcp-refresh.example";

if (TIER0) {
  // tier0: clear DATABASE_URL / REDIS_URL / S3_* (Bun auto-loads them from the
  // dev .env) so the platform picks PGlite + in-memory infra + filesystem
  // storage. PGlite runs against a throwaway temp directory wiped on exit.
  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  delete process.env.S3_BUCKET;
  delete process.env.S3_REGION;
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_PUBLIC_ENDPOINT;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  const pgliteDir = mkdtempSync(join(tmpdir(), "appstrate-test-pglite-"));
  process.env.PGLITE_DATA_DIR = pgliteDir;
  process.env.FS_STORAGE_PATH = mkdtempSync(join(tmpdir(), "appstrate-test-storage-"));
  const storageDir = process.env.FS_STORAGE_PATH;
  process.on("exit", () => {
    try {
      rmSync(pgliteDir, { recursive: true, force: true });
      if (storageDir) rmSync(storageDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup — never let teardown failure mask the test outcome.
    }
  });
} else {
  // tier3: real external services from docker-compose.test.yml.
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.S3_BUCKET = "test-bucket";
  process.env.S3_REGION = "us-east-1";
  // Port 9012 mirrors the MinIO host-port mapping in docker-compose.test.yml
  // (kept off 9000/9002 to avoid colliding with other dev servers on the host).
  process.env.S3_ENDPOINT = "http://localhost:9012";
  process.env.AWS_ACCESS_KEY_ID = "minioadmin";
  process.env.AWS_SECRET_ACCESS_KEY = "minioadmin";
}

// Disable email verification in tests (SMTP vars from .env would enable it)
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;

// Disable Google social auth in tests
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

// Clear env-driven system provider keys — local dev configurations
// shouldn't leak into the test suite (they'd populate the registry
// asymmetrically and break the zero-footprint invariant).
delete process.env.SYSTEM_PROVIDER_KEYS;
if (!TIER0) {
  process.env.DOCKER_SOCKET = "http://localhost:2375";
}

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

if (TIER0) {
  // ─── tier0 core migrations ─────────────────────────────────
  // Importing the db client initializes the throwaway PGlite database; then
  // apply the core Drizzle migrations against it in-process. Shares the same
  // migration walker as the embedded boot path (no drift).
  // migrate.ts lives under apps/api where the @appstrate/db/client alias
  // resolves; its own alias import initializes the (single, shared) PGlite
  // instance that the test helpers + app code also use. Importing the client
  // by relative path here would create a SECOND module instance (symlinked
  // workspace) with its own uninitialized db — so we don't.
  const { applyCorePGliteMigrations } = await import("../../apps/api/src/lib/modules/migrate.ts");
  await applyCorePGliteMigrations(resolve(import.meta.dir, "../../packages/db/drizzle"));
  // Close the embedded PGlite client after the whole suite. Its open handle
  // keeps the event loop alive, so bun force-terminates with a non-zero exit
  // code even on a fully-green run. A top-level `afterAll` in a preload runs
  // ONCE after all tests, so closing here releases the handle for a clean exit
  // without disturbing the shared `db` singleton mid-run.
  const { closeDb } = await import("../../apps/api/test/helpers/db.ts");
  const { afterAll: afterAllTier0 } = await import("bun:test");
  afterAllTier0(async () => {
    await closeDb();
  });
} else {
  // ─── MinIO bucket creation ─────────────────────────────────
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
      [
        "docker",
        "exec",
        TEST_MINIO_CONTAINER,
        "mc",
        "mb",
        "--ignore-existing",
        "local/test-bucket",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
  }

  // ─── DinD: pre-pull alpine image ───────────────────────────
  // Pull alpine:3.20 into the DinD daemon so docker API tests don't wait for pulls.
  Bun.spawnSync(["docker", "-H", "tcp://localhost:2375", "pull", "alpine:3.20"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // ─── Migrations ────────────────────────────────────────────
  // Drop and recreate the test DB to ensure a clean slate (fresh migration).
  // Uses psql via the test postgres container to avoid needing a local client.
  const psqlAdmin = (sqlCommand: string): void => {
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
  };

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

// Modules no longer own migrations — their tables live in the core schema and
// are created by the core migration step above. Nothing to apply per module.

// Dynamic imports are async — bun supports top-level await in preloads.
const { registerTruncationTables } = await import("../../apps/api/test/helpers/db.ts");
const { registerTestModule } = await import("../../apps/api/test/helpers/test-modules.ts");

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
createAuth(contributions.betterAuthPlugins as Parameters<typeof createAuth>[0]);

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
