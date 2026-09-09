// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Final billing drain on organization deletion.
 *
 * REGRESSION under test: nothing billed an org before it was deleted. The
 * platform awaits `onOrgDelete` and only THEN cascades, so an org that spent and
 * deleted itself inside one sweep interval (300 s by default) was never debited
 * — and the sweeper could not even observe the loss, because the org's
 * `llm_usage` rows disappeared with it. Repeatable at will.
 *
 * The drain closes that window without ever moving the global watermark.
 */
import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { truncateEeTables, getEeDb } from "../../helpers/db.ts";
import { seedBillingAccount, seedLlmUsage, seedBillingCursor } from "../../helpers/seed.ts";
import { drainOrgUsage } from "../../../src/billing/org-drain.ts";
import { onOrgDelete } from "../../../src/onboarding/post-signup.ts";
import { runBillingSweep, _resetBillingSweeperForTests } from "../../../src/billing/billing-sweeper.ts"; // prettier-ignore
import { _resetEeEnvForTests } from "../../../src/env.ts";
import { billingAccounts, billingCursor, eeBilledLlmUsage } from "../../../drizzle/schema.ts";
import { logger } from "../../../src/logger.ts";
import { useEeReconciliationEnv, useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();
useEeReconciliationEnv();

const orgId = "00000000-0000-4000-a000-000000000200";
const otherOrgId = "00000000-0000-4000-a000-000000000201";

async function creditsUsed(org: string): Promise<number | null> {
  const db = getEeDb();
  const [account] = await db
    .select({ creditsUsed: billingAccounts.creditsUsed })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, org));
  return account?.creditsUsed ?? null;
}

async function cursorValue(): Promise<number> {
  const db = getEeDb();
  const [row] = await db
    .select({ lastLlmUsageId: billingCursor.lastLlmUsageId })
    .from(billingCursor)
    .where(eq(billingCursor.id, true));
  return row!.lastLlmUsageId;
}

async function claimedIds(ids: number[]): Promise<number[]> {
  const db = getEeDb();
  const rows = await db
    .select({ llmUsageId: eeBilledLlmUsage.llmUsageId })
    .from(eeBilledLlmUsage)
    .where(inArray(eeBilledLlmUsage.llmUsageId, ids));
  return rows.map((r) => r.llmUsageId).sort((a, b) => a - b);
}

describe("final usage drain on org deletion", () => {
  beforeEach(async () => {
    await truncateEeTables();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 20000 });
  });

  it("bills usage the periodic sweep has not reached yet", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-a" }); // 50 credits
    seedLlmUsage({ orgId, costUsd: 0.07, contextId: "run-b" }); // 70 credits

    const result = await drainOrgUsage(orgId);

    expect(result).toMatchObject({ scanned: 2, billed: 2, credits: 120, truncated: false });
    expect(await creditsUsed(orgId)).toBe(120);
  });

  it("REGRESSION: bills a row of the org that committed late BELOW the watermark", async () => {
    // The row the periodic sweep's replay window exists for — a low serial id
    // published after the watermark passed it. Starting the drain strictly above
    // the watermark debited 0 and the org's ledger row then cascaded away, so
    // the sweep never got its replay: the loss was final.
    await seedBillingCursor(3);
    seedLlmUsage({ orgId, id: 2, costUsd: 0.05, contextId: "run-late-commit" });

    const result = await drainOrgUsage(orgId);

    expect(result.credits).toBe(50);
    expect(await creditsUsed(orgId)).toBe(50);
    expect(await cursorValue()).toBe(3); // still out of band
  });

  it("does not reach below the cutover floor", async () => {
    // Same selection rule as the sweep, floor included: usage the cutover
    // excluded is not billed by the deletion path either.
    await seedBillingCursor(3, 3);
    seedLlmUsage({ orgId, id: 2, costUsd: 0.05, contextId: "run-historical" });

    const result = await drainOrgUsage(orgId);

    expect(result).toMatchObject({ scanned: 0, billed: 0, credits: 0 });
    expect(await creditsUsed(orgId)).toBe(0);
  });

  it("never moves the global watermark", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05 });

    await drainOrgUsage(orgId);

    // The drain bills out of band; the cursor is the periodic sweep's alone.
    expect(await cursorValue()).toBe(0);
  });

  it("bills past another tenant's head-of-line stall without rewinding anything", async () => {
    // The global cursor is wedged behind another org's unsettled system row, so
    // the periodic sweep cannot reach this org's rows at all. The drain must
    // still bill them — it filters by org and never advances the watermark.
    await seedBillingAccount({ orgId: otherOrgId, creditsUsed: 0, creditQuota: 20000 });
    await seedBillingCursor(0);
    seedLlmUsage({ orgId: otherOrgId, costUsd: 0.5, settled: false }); // id 1 wedged
    const mine = seedLlmUsage({ orgId, costUsd: 0.09, contextId: "run-behind-stall" }); // id 2

    // Confirm the sweep really is stuck.
    const swept = await runBillingSweep();
    expect(swept.stalledOnId).toBe(1);
    expect(await creditsUsed(orgId)).toBe(0);

    const result = await drainOrgUsage(orgId);

    expect(result.billed).toBe(1);
    expect(await creditsUsed(orgId)).toBe(90);
    expect(await cursorValue()).toBe(0); // untouched
    expect(await claimedIds([mine])).toEqual([mine]);
  });

  it("skips unsettled rows rather than billing a non-final cost", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-final" }); // settled
    seedLlmUsage({ orgId, costUsd: 9.99, settled: false, contextId: "run-inflight" });

    const result = await drainOrgUsage(orgId);

    expect(result).toMatchObject({ billed: 1, unsettled: 1 });
    expect(await creditsUsed(orgId)).toBe(50); // NOT 50 + 9990
  });

  it("never bills BYOK rows", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 5, credentialSource: "org" });

    const result = await drainOrgUsage(orgId);

    expect(result.billed).toBe(0);
    expect(await creditsUsed(orgId)).toBe(0);
  });

  it("leaves the periodic sweep a no-op for the rows it already billed", async () => {
    await seedBillingCursor(0);
    seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-drained" });
    seedLlmUsage({ orgId: otherOrgId, costUsd: 0.02, contextId: "run-other" });
    await seedBillingAccount({ orgId: otherOrgId, creditsUsed: 0, creditQuota: 20000 });

    await drainOrgUsage(orgId);
    expect(await creditsUsed(orgId)).toBe(50);

    // The sweep re-reads both rows; the claim table dedupes the drained one.
    const swept = await runBillingSweep();
    expect(swept.alreadyBilled).toBe(1);
    expect(swept.billed).toBe(1);
    expect(await creditsUsed(orgId)).toBe(50); // no double debit
    expect(await creditsUsed(otherOrgId)).toBe(20);
    expect(await cursorValue()).toBe(2);
  });

  it("claims an unpriced row at 0 credits and names the org in one error line", async () => {
    // Claiming it is what stops a later sweep billing it twice; the 0 credits is
    // what stops it being billed at a price nobody computed. The `error` line is
    // the only trace an operator has of the revenue that went uncharged, so it
    // names the org and appears exactly once for the drain.
    await seedBillingCursor(0);
    const id = seedLlmUsage({
      orgId,
      costUsd: 4.2,
      contextId: "run-unpriced",
      pricingStatus: "unpriced",
    });

    const errorSpy = spyOn(logger, "error");
    let result: Awaited<ReturnType<typeof drainOrgUsage>>;
    let pricingErrors: unknown[][];
    try {
      result = await drainOrgUsage(orgId);
      pricingErrors = errorSpy.mock.calls.filter(
        ([msg]) => typeof msg === "string" && msg.includes("could not price in full"),
      );
    } finally {
      errorSpy.mockRestore();
    }

    expect(result!).toMatchObject({ scanned: 1, billed: 1, credits: 0 });
    expect(result!.pricing.unpriced).toBe(1);
    expect(await creditsUsed(orgId)).toBe(0);
    expect(await claimedIds([id])).toEqual([id]);
    expect(pricingErrors!).toHaveLength(1);
    expect(pricingErrors![0]![1]).toMatchObject({ unpriced: 1, orgIds: [orgId] });
  });

  it("onOrgDelete drains BEFORE it deletes the account", async () => {
    // The debit has to land while the account still exists. Order matters: had
    // the delete run first, the drain would report an account-less org instead.
    await seedBillingCursor(0);
    const id = seedLlmUsage({ orgId, costUsd: 0.05, contextId: "run-last-gasp" });

    await onOrgDelete(orgId);

    // Account and usage records are gone (the deletion still happened) …
    expect(await creditsUsed(orgId)).toBeNull();
    // … but the row was claimed on the way out, which is only possible if the
    // drain ran first and found an account to debit.
    expect(await claimedIds([id])).toEqual([id]);
    expect(await cursorValue()).toBe(0);
  });

  it("onOrgDelete still completes when there is nothing to drain", async () => {
    await seedBillingCursor(0);

    await onOrgDelete(orgId);

    expect(await creditsUsed(orgId)).toBeNull();
  });
});
