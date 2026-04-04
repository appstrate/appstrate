/**
 * Test preload for MINIMAL profile — PostgreSQL only.
 *
 * No Redis, no S3/MinIO. All infra adapters fall back to local/in-memory.
 * Starts only the test PostgreSQL container.
 */
import { resolve } from "path";

// ─── Docker Compose (PostgreSQL only) ────────────────────────
const composeFile = resolve(import.meta.dir, "docker-compose.test.yml");
const compose = Bun.spawnSync(
  ["docker", "compose", "-f", composeFile, "up", "-d", "--wait", "postgres-test"],
  { stdout: "pipe", stderr: "pipe" },
);
if (compose.exitCode !== 0) {
  const stderr = compose.stderr.toString();
  throw new Error(`Docker Compose failed (exit ${compose.exitCode}): ${stderr}`);
}

// ─── Environment (minimal — no Redis, no S3) ─────────────────
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:5433/appstrate_test";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long-for-hmac";
process.env.CONNECTION_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
);
process.env.APP_URL = "http://localhost:3000";
process.env.TRUSTED_ORIGINS = "http://localhost:3000";
process.env.LOG_LEVEL = "error";
process.env.RUN_ADAPTER = "process";
process.env.SIDECAR_POOL_SIZE = "0";

// Explicitly unset Redis and S3 to ensure local adapters are used
delete process.env.REDIS_URL;
delete process.env.S3_BUCKET;
delete process.env.S3_REGION;
delete process.env.S3_ENDPOINT;
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;

// Disable email/social auth
delete process.env.SMTP_HOST;
delete process.env.SMTP_PORT;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.SMTP_FROM;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;

// ─── Migrations ──────────────────────────────────────────────
const dbDir = resolve(import.meta.dir, "../../packages/db");
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
