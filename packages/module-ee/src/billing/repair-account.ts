/**
 * Operator repair for an organization that has billable usage and no billing
 * account — the "bricked org" the billing sweep reports at `error` level.
 *
 * HOW AN ORG GETS THERE. `onOrgDelete` deletes `cloud_billing_accounts`
 * immediately, but the platform REFUSES to delete an organization while a run is
 * active, so the org can survive its own account. Everything it spends after
 * that has nowhere to be debited.
 *
 * WHAT THE SWEEP DOES MEANWHILE. It isolates the org: the rows are still claimed
 * and `cloud_usage_records` still accumulates the exact debt, but no account is
 * touched and the pass commits — the rest of the fleet keeps being billed. (The
 * previous behavior aborted the whole transaction, which froze billing for every
 * tenant until an operator fixed the database by hand.)
 *
 * WHAT THIS DOES. Re-provisions the account (idempotent, reusing the same
 * free-tier claim path as org creation, so a re-provisioned org cannot mint a
 * second free tier) and then applies the debt recorded while it had no account:
 * `credits_used = SUM(cloud_usage_records.cost_credits)` for the org.
 *
 * WHY THE SUM, RATHER THAN LETTING THE NORMAL DEBIT PATH REPLAY IT. It cannot:
 * the orphaned rows were CLAIMED into `cloud_billed_llm_usage` and the watermark
 * advanced past them in the SAME committed transaction that recorded the debt
 * (`billLedgerRows` claims before it debits; `sweepLedgerBatch` advances the
 * cursor in that transaction). The sweep only ever reads
 * `usage.list({ afterId: watermark })`, so those ids are unreachable forever,
 * and even a re-read would be a no-op — `billLedgerRows` only updates usage
 * records for rows its `ON CONFLICT DO NOTHING` actually won. The recorded
 * records are therefore the only remaining trace of the debt.
 *
 * That sum is exactly the un-debited debt BECAUSE the account is absent: org
 * deletion removes the account and its usage records together, so every usage
 * record present now was written after the account disappeared. The same
 * reconstruction would be WRONG on an existing account (a Stripe renewal resets
 * `credits_used` to 0 while historical usage records remain), which is why this
 * refuses to touch an org that already has one.
 */

import { eq, sql } from "drizzle-orm";
import { getCloudDb } from "../db.ts";
import { billingAccounts, orgUsageRecords } from "../../drizzle/schema.ts";
import { normalizeEmail, provisionBillingAccount } from "../onboarding/post-signup.ts";
import { logger } from "../logger.ts";

export type RepairOutcome =
  | { status: "already_provisioned" }
  /** `creditQuota` is 0 when the owner's email had already claimed the free tier. */
  | { status: "repaired"; creditQuota: number; creditsApplied: number };

/**
 * Re-provision a missing billing account and apply the usage recorded while it
 * was missing. Refuses (without writing anything) when the account already
 * exists — there is nothing to repair, and reconstructing `credits_used` from
 * usage records would clobber a legitimate renewal reset.
 */
export async function repairBillingAccount(
  orgId: string,
  ownerEmail: string,
): Promise<RepairOutcome> {
  const db = getCloudDb();

  const [existing] = await db
    .select({ orgId: billingAccounts.orgId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  if (existing) return { status: "already_provisioned" };

  const { creditQuota } = await provisionBillingAccount(
    orgId,
    normalizeEmail(ownerEmail),
    ownerEmail,
  );

  // Apply the debt the sweep recorded but could not debit. Computed in SQL from
  // the org's usage records so no float round-trips through JS.
  const [applied] = await db
    .update(billingAccounts)
    .set({
      creditsUsed: sql`COALESCE((
        SELECT SUM(${orgUsageRecords.costCredits}) FROM ${orgUsageRecords}
        WHERE ${orgUsageRecords.orgId} = ${orgId}
      ), 0)`,
      updatedAt: new Date(),
    })
    .where(eq(billingAccounts.orgId, orgId))
    .returning({ creditsUsed: billingAccounts.creditsUsed });

  const creditsApplied = applied?.creditsUsed ?? 0;
  logger.info("billing account repaired", { orgId, creditQuota, creditsApplied });
  return { status: "repaired", creditQuota, creditsApplied };
}
