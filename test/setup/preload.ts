/**
 * Test preload script — runs once before any test file.
 *
 * 1. Starts test containers (PostgreSQL + Redis + MinIO + DinD) if not already running
 * 2. Sets environment variables for the test database and Redis
 * 3. Runs Drizzle migrations against the test database (core + all modules)
 * 4. Registers module-owned tables for truncation
 *
 * Module discovery: each built-in module under apps/api/src/modules/<name>/ contributes:
 *   - index.ts — default-exports an AppstrateModule (used by getTestApp)
 *   - drizzle/migrations/NNNN_name.sql — applied in file-name order (alphabetical)
 *   - test/tables.ts — default-exports a string[] of tables for truncateAll()
 *
 * Both are optional. Running core tests alone still picks up installed modules
 * because anything under the modules directory is part of the repo — there is
 * no "module disabled" state in tests, unlike production (APPSTRATE_MODULES env var).
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
process.env.CONNECTION_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
); // 32 bytes
process.env.S3_BUCKET = "test-bucket";
process.env.S3_REGION = "us-east-1";
process.env.S3_ENDPOINT = "http://localhost:9002";
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
// Auto-discover every built-in module under apps/api/src/modules/*/ and
// wire up its test infrastructure. We do this from the root preload (not
// per-module) so that `bun test` from any directory sees a consistent state.

const modulesRoot = resolve(import.meta.dir, "../../apps/api/src/modules");
const moduleDirs = existsSync(modulesRoot)
  ? readdirSync(modulesRoot)
      .map((name) => join(modulesRoot, name))
      .filter((path) => statSync(path).isDirectory())
  : [];

for (const moduleDir of moduleDirs) {
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

for (const moduleDir of moduleDirs) {
  // Register the module itself so getTestApp() can mount its router
  const indexFile = join(moduleDir, "index.ts");
  if (existsSync(indexFile)) {
    const imported: { default?: AppstrateModule } = await import(indexFile);
    if (imported.default) {
      registerTestModule(imported.default);
    }
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
