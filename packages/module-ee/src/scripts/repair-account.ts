// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * CLI: `bun run repair:account -- <orgId> <ownerEmail>`
 *
 * Repairs an organization the billing sweep reported as
 * "billable usage for an org with no billing account". Standalone: it opens
 * `DATABASE_URL` and writes only `ee_*` rows, so it can be run against a live
 * deployment without the API process.
 *
 * The storage entitlement is NOT projected here (that write needs the platform
 * handle, which only exists inside the running module); the periodic
 * entitlement resync repairs it within one interval.
 */

import { initEeDb, closeEeDb } from "../db.ts";
import { repairBillingAccount } from "../billing/repair-account.ts";

const [orgId, ownerEmail] = process.argv.slice(2);

if (!orgId || !ownerEmail) {
  process.stderr.write("usage: bun run repair:account -- <orgId> <ownerEmail>\n");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is required — it is where the ee_* tables live\n");
  process.exit(2);
}

initEeDb(databaseUrl);
try {
  const outcome = await repairBillingAccount(orgId, ownerEmail);
  if (outcome.status === "already_provisioned") {
    process.stderr.write(
      `org ${orgId} already has a billing account — nothing to repair (refusing to rewrite credits_used)\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `repaired ${orgId}: credit_quota=${outcome.creditQuota} credits_used=${outcome.creditsApplied}\n`,
  );
} finally {
  await closeEeDb();
}
