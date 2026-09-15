// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

// Harness requirements (`test/setup/modules.ts`). The module's tables live in
// the platform database, so it needs the real PostgreSQL the harness provides
// and no URL of its own: tier-0 PGlite offers neither postgres.js nor the
// `DATABASE_URL` the module reads at init.

export default {
  postgres: true,
  env: {
    STRIPE_SECRET_KEY: "sk_test_fake_key_for_testing",
    STRIPE_WEBHOOK_SECRET: "whsec_test_secret_for_webhook_verification",
    STRIPE_PRICE_ID_STARTER: "price_starter_test",
    STRIPE_PRICE_ID_PRO: "price_pro_test",
    // A sweep firing mid-suite would bill rows a test seeded into the ledger. This
    // pauses METERING only — `useEeTestSeams()` disarms the maintenance tick that
    // keeps running under it.
    EE_RECONCILIATION_INTERVAL_SECONDS: "0",
  },
} as const;
