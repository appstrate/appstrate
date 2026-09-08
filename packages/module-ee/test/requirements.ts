// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

// Harness requirements (`test/setup/modules.ts`): tier-0 PGlite offers neither
// CREATE DATABASE nor postgres.js. `env` is force-assigned before the entry is
// imported because the suite DROPS these tables and a dev `.env` may name a
// real one; values are computed, since tier 0 reads this with only ambient env.

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
    // A timer firing mid-suite would bill rows a test seeded into the ledger.
    EE_RECONCILIATION_INTERVAL_SECONDS: "0",
  },
} as const;
