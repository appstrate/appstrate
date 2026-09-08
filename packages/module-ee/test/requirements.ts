// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * What this module needs from the test harness (see `test/setup/modules.ts`).
 *
 * `postgres: true` — it runs `CREATE DATABASE` and connects with `postgres.js`
 * against a database of its own, neither of which the tier-0 PGlite adapter
 * offers. Under `TEST_TIER=0` the module is not imported, not initialized, and
 * its own test files are not collected.
 *
 * `env` is applied with `??=` before the module entry is imported, which is the
 * only window that works: the env is parsed and cached on the first
 * `getEeEnv()`. Values are computed, never asserted — the tier-0 runner imports
 * this file with only the ambient environment.
 */

/** The module's own database on the platform's test PostgreSQL server. */
function eeDatabaseUrl(): string {
  const url = new URL(
    process.env.DATABASE_URL ?? "postgres://test:test@localhost:5433/appstrate_test",
  );
  url.pathname = "/appstrate_test_ee";
  return url.toString();
}

export default {
  postgres: true,
  env: {
    EE_DATABASE_URL: eeDatabaseUrl(),
    STRIPE_SECRET_KEY: "sk_test_fake_key_for_testing",
    STRIPE_WEBHOOK_SECRET: "whsec_test_secret_for_webhook_verification",
    STRIPE_PRICE_ID_STARTER: "price_starter_test",
    STRIPE_PRICE_ID_PRO: "price_pro_test",
    // Disarm the periodic sweep. `init()` runs under the harness like any other
    // module, and a timer firing mid-suite would bill rows a test seeded into
    // the mock ledger. The sweep functions are still driven directly by
    // `test/integration/services/billing-sweeper.test.ts`.
    CLOUD_RECONCILIATION_INTERVAL_SECONDS: "0",
  },
} as const;
