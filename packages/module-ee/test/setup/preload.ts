/**
 * Test preload script — runs once before any test file.
 *
 * 1. Starts test containers (PostgreSQL + Redis) via Docker Compose
 * 2. Sets environment variables for test database, Redis, and Stripe
 * 3. Starts the Stripe mock server (Bun.serve on OS-assigned port)
 * 4. Calls cloudModule.init(ctx) which validates env, inits DB/Redis, and runs migrations
 *
 * IMPORTANT: The Stripe mock must start BEFORE init() because init()
 * calls getCloudEnv() which caches env vars. STRIPE_MOCK_HOST/PORT must be set
 * before any module that imports getStripe() is loaded.
 */
import { resolve } from "path";

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

// ─── Environment ────────────────────────────────────────────────
// Set test env vars BEFORE any module that calls getCloudEnv() is imported.
// Bun preload runs before test files, so getCloudEnv() will pick these up.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@localhost:5434/cloud_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6381";

process.env.DATABASE_URL = TEST_DATABASE_URL;
// Cloud owns its database — its tables live under CLOUD_DATABASE_URL. In tests
// that is the same physical PostgreSQL as the platform's test DB (cloud_* and
// platform tables never collide), so a single URL is fine.
process.env.CLOUD_DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
// The platform's built-in module set plus this one — the deployment shape these
// tests emulate. Inert (cloud reads neither `MODULES` nor `DATABASE_URL`), set
// so the emulated platform env is not a fiction: the previous value named
// `scheduling` and `provider-management`, neither of which is a module — both
// deliberately live in core.
process.env.MODULES = "oidc,webhooks,mcp,core-providers,@appstrate/cloud";
process.env.STRIPE_SECRET_KEY = "sk_test_fake_key_for_testing";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_secret_for_webhook_verification";
process.env.STRIPE_PRICE_ID_STARTER = "price_starter_test";
process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
process.env.LOG_LEVEL = "error"; // Suppress logs during tests

// ─── Stripe Mock Server ─────────────────────────────────────────
// Start the mock BEFORE initCloud so STRIPE_MOCK_HOST/PORT are available
// when getStripe() is first called (Stripe client caches config on creation).

const { startStripeMock } = await import("../helpers/stripe.ts");
const { port: stripeMockPort } = startStripeMock();

// Mark the test env so the Stripe client honors the mock-host redirect
// (gated on NODE_ENV in src/stripe/client.ts — never active in production).
process.env.NODE_ENV = "test";
process.env.STRIPE_MOCK_HOST = "localhost";
process.env.STRIPE_MOCK_PORT = String(stripeMockPort);

// No OSS stub tables: cloud owns its database and never reads platform tables.
// The platform `llm_usage` ledger is served through the mock `PlatformServices`
// (see `test/helpers/mock-platform.ts`) — cloud sweeps it by serial-`id` cursor,
// so there are no `runs`/`llm_usage` stubs.
//
// Fresh-reset the cloud schema before init self-migrates. The test DB persists
// across runs, so we drop cloud_* tables + the drizzle journal to guarantee a
// clean apply of the full migration chain (0000 then the incremental 0001 —
// the same ordered path production takes; production data exists there).
import postgres from "postgres";

const reset = postgres(TEST_DATABASE_URL, { max: 1 });
await reset`
  DROP TABLE IF EXISTS
    cloud_usage_records, cloud_billed_llm_usage, cloud_billing_cursor,
    cloud_stripe_events, cloud_free_tier_claims, cloud_billing_managers,
    cloud_billing_accounts,
    "__drizzle_migrations" CASCADE
`;
await reset`DROP SCHEMA IF EXISTS drizzle CASCADE`;
await reset.end();

// ─── Initialize Cloud Module ────────────────────────────────────
// Validates env, initializes DB + Redis, and self-migrates cloud's own DB.

// The two org queries cloud narrows its init context with. Tests drive them
// through `test/helpers/org-queries.ts` rather than a platform database.
const { orgQueries } = await import("../helpers/org-queries.ts");

const cloudModule = (await import("../../src/index.ts")).default;
await cloudModule.init({
  redisUrl: TEST_REDIS_URL,
  appUrl: "http://localhost:3000",
  getSendMail: async () => () => {},
  // `getOrgAdminEmails` is still required by the platform's `ModuleInitContext`
  // and is no longer read by cloud — it is deleted from the contract in the
  // same core release this module's peer floor names, and this line goes with it.
  getOrgAdminEmails: async () => [],
  getOrgName: async () => null,
  ...orgQueries,
  services: (await import("../helpers/mock-platform.ts")).mockPlatformServices,
});
