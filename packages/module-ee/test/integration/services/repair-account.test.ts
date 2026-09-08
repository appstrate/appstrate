// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `repair:account` — recovery for an org the sweep isolated because it has
 * billable usage and no billing account.
 *
 * The sweep no longer aborts on that org (which used to freeze billing for the
 * whole fleet); it records the debt in `ee_usage_records`, reports the org at
 * `error` level, and moves on. This is the other half: re-provision the account
 * and apply the recorded debt, so the isolation is temporary rather than a
 * silent write-off.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateEeTables, getEeDb } from "../../helpers/db.ts";
import {
  seedBillingAccount,
  seedLlmUsage,
  seedBillingCursor,
  seedFreeTierClaim,
} from "../../helpers/seed.ts";
import { runBillingSweep, _resetBillingSweeperForTests } from "../../../src/billing/billing-sweeper.ts"; // prettier-ignore
import { repairBillingAccount } from "../../../src/billing/repair-account.ts";
import { _resetEeEnvForTests } from "../../../src/env.ts";
import { billingAccounts } from "../../../drizzle/schema.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

const orgId = "00000000-0000-4000-a000-000000000300";

async function account() {
  const db = getEeDb();
  const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
  return row ?? null;
}

describe("repairBillingAccount", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
  });

  it("re-provisions the account and applies the debt the sweep could not debit", async () => {
    // The org spends with no account: the sweep records the usage and isolates it.
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-1" }); // 50 credits
    seedLlmUsage({ orgId, costUsd: 0.07, contextId: "run-2" }); // 70 credits
    const swept = await runBillingSweep();
    expect(swept.orphanedOrgs).toBe(1);
    expect(await account()).toBeNull();

    const outcome = await repairBillingAccount(orgId, "owner@example.com");

    expect(outcome).toMatchObject({ status: "repaired", creditQuota: 5000, creditsApplied: 120 });
    const repaired = await account();
    expect(repaired!.creditQuota).toBe(5000);
    // The 120 credits recorded while the account was missing are now debited.
    expect(repaired!.creditsUsed).toBe(120);
  });

  it("does not mint a second free tier for an email that already claimed one", async () => {
    await seedFreeTierClaim({ email: "owner@example.com" });
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.01, contextId: "run-1" });
    await runBillingSweep();

    const outcome = await repairBillingAccount(orgId, "owner@example.com");

    expect(outcome).toMatchObject({ status: "repaired", creditQuota: 0 });
    const repaired = await account();
    expect(repaired!.creditQuota).toBe(0);
    expect(repaired!.creditsUsed).toBe(10);
  });

  it("normalizes the email like org creation does (no alias bypass)", async () => {
    await seedFreeTierClaim({ email: "owner@gmail.com" });

    const outcome = await repairBillingAccount(orgId, "O.w.n.e.r+alias@googlemail.com");

    // Free tier already claimed by the canonical address → 0 credits granted.
    expect(outcome).toMatchObject({ status: "repaired", creditQuota: 0 });
  });

  it("refuses an org that already has an account, without writing anything", async () => {
    // Reconstructing `credits_used` from usage records is only correct for a
    // BRAND-NEW account: a Stripe renewal resets `credits_used` to 0 while the
    // historical usage records remain, so replaying them would re-charge a
    // paying customer for a period they already paid.
    await seedBillingAccount({ orgId, creditsUsed: 42, creditQuota: 20000 });

    const outcome = await repairBillingAccount(orgId, "owner@example.com");

    expect(outcome).toEqual({ status: "already_provisioned" });
    expect((await account())!.creditsUsed).toBe(42);
  });

  it("leaves the org billable again — the next sweep debits it normally", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-1" });
    await runBillingSweep();
    await repairBillingAccount(orgId, "owner@example.com");
    expect((await account())!.creditsUsed).toBe(50);

    seedLlmUsage({ orgId, costUsd: 0.02, contextId: "run-2" });
    const swept = await runBillingSweep();

    expect(swept.orphanedOrgs).toBe(0);
    expect((await account())!.creditsUsed).toBe(70);
  });
});
