/**
 * Test preload script — runs once before any test file.
 *
 * 1. Starts test containers (PostgreSQL + Redis) if not already running
 * 2. Sets environment variables for the test database and Redis
 * 3. Runs Drizzle migrations against the test database
 */
import { resolve } from "path";

// ─── Docker Compose (idempotent — no-op if already running) ─────
const composeFile = resolve(import.meta.dir, "docker-compose.test.yml");
const compose = Bun.spawnSync(
  ["docker", "compose", "-f", composeFile, "up", "-d", "--wait"],
  { stdout: "pipe", stderr: "pipe" },
);
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
process.env.CONNECTION_ENCRYPTION_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef",
).toString("base64"); // 32 bytes
process.env.S3_BUCKET = "test-bucket";
process.env.S3_REGION = "us-east-1";
process.env.S3_ENDPOINT = "http://localhost:9002";
process.env.AWS_ACCESS_KEY_ID = "minioadmin";
process.env.AWS_SECRET_ACCESS_KEY = "minioadmin";
process.env.APP_URL = "http://localhost:3000";
process.env.LOG_LEVEL = "error"; // Suppress logs during tests
process.env.SIDECAR_POOL_SIZE = "0"; // Disable sidecar pool in tests
process.env.DOCKER_SOCKET = "http://localhost:2375";

// ─── MinIO bucket creation ───────────────────────────────────
// Create the test bucket via mc inside the MinIO container (idempotent).
const mcAlias = Bun.spawnSync(
  ["docker", "exec", "setup-minio-test-1", "mc", "alias", "set", "local", "http://localhost:9000", "minioadmin", "minioadmin"],
  { stdout: "pipe", stderr: "pipe" },
);
if (mcAlias.exitCode === 0) {
  Bun.spawnSync(
    ["docker", "exec", "setup-minio-test-1", "mc", "mb", "--ignore-existing", "local/test-bucket"],
    { stdout: "pipe", stderr: "pipe" },
  );
}

// ─── DinD: pre-pull alpine image ─────────────────────────────
// Pull alpine:3.20 into the DinD daemon so docker API tests don't wait for pulls.
Bun.spawnSync(
  ["docker", "-H", "tcp://localhost:2375", "pull", "alpine:3.20"],
  { stdout: "pipe", stderr: "pipe" },
);

// ─── Migrations ─────────────────────────────────────────────
// Run drizzle-kit migrate as a subprocess from the packages/db directory,
// since the postgres driver is a dependency of @appstrate/db, not @appstrate/api.

const dbDir = resolve(import.meta.dir, "../../../../packages/db");
const result = Bun.spawnSync(["bunx", "drizzle-kit", "migrate"], {
  cwd: dbDir,
  env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  stdout: "pipe",
  stderr: "pipe",
});

if (result.exitCode !== 0) {
  const stderr = result.stderr.toString();
  throw new Error(`Migration failed (exit ${result.exitCode}): ${stderr}`);
}

