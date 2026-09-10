// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Durable cancellation of an org's Stripe subscription on org deletion: the intent is
 * written first (`cancel_requested_at`), the account row survives a failed cancellation
 * for the sweeper to retry, and the rows go once Stripe confirms. Deleting the row on an
 * unconfirmed cancellation leaves a subscription charging a customer that nothing names.
 */

import { eq, isNotNull } from "drizzle-orm";
import { getEeDb } from "../db.ts";
import { billingAccounts, orgUsageRecords } from "../../drizzle/schema.ts";
import { cancelSubscription } from "../stripe/cancel.ts";
import { logger } from "../logger.ts";
import { deleteBillingManagers } from "./managers.ts";

/** Remove the org's EE-owned rows: no EE table FKs the platform, so nothing cascades. */
async function deleteOrgBillingRows(orgId: string): Promise<void> {
  const db = getEeDb();
  await deleteBillingManagers(orgId);
  await db.delete(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
  await db.delete(billingAccounts).where(eq(billingAccounts.orgId, orgId));
}

/**
 * Cancel the org's subscription and delete its EE rows — the terminal half of
 * `onOrgDelete`, and the body the sweeper's retry re-runs. On failure everything stays
 * put, which is what makes the retry possible.
 */
export async function cancelSubscriptionAndCleanUp(
  orgId: string,
  subscriptionId: string | null,
): Promise<boolean> {
  if (subscriptionId !== null) {
    await getEeDb()
      .update(billingAccounts)
      .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(billingAccounts.orgId, orgId));

    if (!(await cancelSubscription(subscriptionId, { orgId, reason: "org-deleted" }))) return false;
  }

  await deleteOrgBillingRows(orgId);
  return true;
}

/** What one {@link retryPendingCancellations} pass did. */
interface PendingCancellationResult {
  /** Accounts still carrying an unconfirmed cancellation when the pass started. */
  pending: number;
  /** Of those, the ones Stripe confirmed — their rows are now gone. */
  cleared: number;
}

/** Retry every cancellation `onOrgDelete` could not confirm. Rides the billing tick. */
export async function retryPendingCancellations(): Promise<PendingCancellationResult> {
  const pending = await getEeDb()
    .select({
      orgId: billingAccounts.orgId,
      stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
    })
    .from(billingAccounts)
    .where(isNotNull(billingAccounts.cancelRequestedAt));

  let cleared = 0;
  for (const account of pending) {
    if (await cancelSubscriptionAndCleanUp(account.orgId, account.stripeSubscriptionId)) cleared++;
  }

  if (pending.length > 0) {
    logger.info("retried Stripe cancellations for deleted orgs", {
      pending: pending.length,
      cleared,
    });
  }

  return { pending: pending.length, cleared };
}
