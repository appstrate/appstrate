// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Cancelling an organization's Stripe subscription when the organization is
 * deleted — durably.
 *
 * WHY THIS IS NOT JUST A `subscriptions.cancel` CALL
 *
 * `onOrgDelete` used to call Stripe, log a failure, and delete the billing
 * account anyway. The subscription id died with the row, so a Stripe blip left a
 * subscription charging a customer every month for an organization that no
 * longer existed, with nothing left in the system that could name it. A log line
 * is a diagnosis, not a recovery.
 *
 * So the intent is written down first (`cancel_requested_at`) and the account
 * row — with its `stripe_subscription_id` — SURVIVES a failed cancellation. The
 * billing sweeper retries it on every tick and removes the rows once Stripe has
 * confirmed. The org is already gone from the platform; these rows are the
 * receipt for unfinished business with Stripe.
 */

import Stripe from "stripe";
import { eq, isNotNull } from "drizzle-orm";
import { getEeDb } from "../db.ts";
import { billingAccounts, orgUsageRecords } from "../../drizzle/schema.ts";
import { getStripe } from "../stripe/client.ts";
import { logger } from "../logger.ts";
import { deleteBillingManagers } from "./managers.ts";

/**
 * Stripe's sentence for "this subscription is already canceled", which it
 * returns as a 400 with no distinguishing `code`. Anchored at the start and
 * matched whole: any other 400 — a bad parameter, a permission refusal, a
 * message that merely mentions cancellation — is a real failure, and reading it
 * as success would delete the rows that hold the subscription id, leaving a
 * live subscription charging a customer with nothing left to name it.
 */
const ALREADY_CANCELED_MESSAGE =
  /^A canceled subscription can only update its cancellation_details/;

/**
 * Is this failure indistinguishable from success?
 *
 * A subscription Stripe no longer has — deleted out of band, or cancelled by an
 * earlier attempt whose response we lost — is exactly the state we were asking
 * for. Retrying it forever would keep a dead org's rows alive on a cancellation
 * that already happened.
 *
 *   - `resource_missing` / 404: no such subscription;
 *   - a 400 carrying {@link ALREADY_CANCELED_MESSAGE}, the one sentence Stripe
 *     answers a cancel-the-already-canceled request with.
 */
function isAlreadyCanceled(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  if (err.code === "resource_missing" || err.statusCode === 404) return true;
  return err.statusCode === 400 && ALREADY_CANCELED_MESSAGE.test(err.message);
}

/**
 * Ask Stripe to cancel `subscriptionId`. Returns whether the subscription is now
 * gone — which includes "it was already gone". Never throws: the caller decides
 * what an unconfirmed cancellation means, and here it always means "keep the
 * reference and try again".
 */
async function cancelSubscription(orgId: string, subscriptionId: string): Promise<boolean> {
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
    logger.info("Stripe subscription canceled for a deleted org", { orgId, subscriptionId });
    return true;
  } catch (err) {
    if (isAlreadyCanceled(err)) {
      logger.info("Stripe subscription was already gone for a deleted org", {
        orgId,
        subscriptionId,
      });
      return true;
    }
    logger.error("Failed to cancel Stripe subscription — billing rows kept for retry", {
      orgId,
      subscriptionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Remove the org's EE-owned rows. No EE table carries an FK to the platform's
 * `organizations`, so nothing cascades — these deletes are the whole cleanup.
 * (`ee_billed_llm_usage` is keyed by ledger id, not org: its rows are billed
 * markers and stay. `ee_billing_cursor` is a global singleton.)
 */
async function deleteOrgBillingRows(orgId: string): Promise<void> {
  const db = getEeDb();
  await deleteBillingManagers(orgId);
  await db.delete(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
  await db.delete(billingAccounts).where(eq(billingAccounts.orgId, orgId));
}

/**
 * Cancel the org's subscription and delete its EE rows — the terminal half of
 * `onOrgDelete`, and the body the sweeper's retry re-runs.
 *
 * Order is the point: the intent is durable BEFORE the network call, and the
 * rows are deleted only once Stripe has confirmed. On failure everything stays
 * exactly where it is, which is what makes the retry possible at all.
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

    if (!(await cancelSubscription(orgId, subscriptionId))) return false;
  }

  await deleteOrgBillingRows(orgId);
  return true;
}

/** What one {@link retryPendingCancellations} pass did. */
export interface PendingCancellationResult {
  /** Accounts still carrying an unconfirmed cancellation when the pass started. */
  pending: number;
  /** Of those, the ones Stripe confirmed — their rows are now gone. */
  cleared: number;
}

/**
 * Retry every cancellation `onOrgDelete` could not confirm. Rides the billing
 * tick.
 *
 * Steady state is zero rows and zero work. A row here means a customer may still
 * be charged for an organization that no longer exists, so the pass runs until
 * Stripe answers — and each attempt is idempotent, because a subscription Stripe
 * has already cancelled counts as success.
 */
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
