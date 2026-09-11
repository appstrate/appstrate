// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The one way EE ends a subscription at Stripe. Its two callers share nothing else — an org
 * being deleted, and a duplicate checkout being reconciled — but both need the same
 * subtlety: Stripe reports "already canceled" as an undistinguished 400, and reading that
 * as a failure turns an idempotent retry into a permanent one.
 */

import Stripe from "stripe";
import { getStripe } from "./client.ts";
import { logger } from "../logger.ts";

/**
 * Stripe's sentence for "already canceled", returned as a 400 with no distinguishing
 * `code`. Anchored: reading any other 400 as success drops a live subscription.
 */
const ALREADY_CANCELED_MESSAGE =
  /^A canceled subscription can only update its cancellation_details/;

/** Is this failure indistinguishable from success — a subscription Stripe no longer has? */
function isAlreadyCanceled(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) return false;
  if (err.code === "resource_missing" || err.statusCode === 404) return true;
  return err.statusCode === 400 && ALREADY_CANCELED_MESSAGE.test(err.message);
}

/**
 * Cancel `subscriptionId`; true when it is gone, "already gone" included. Never throws:
 * each caller carries its own retry (the deletion sweeper, a Stripe webhook redelivery)
 * and needs the failure as a value it can act on, not as an exception.
 *
 * `context` is merged into the log line so the caller's reason is on the record.
 */
export async function cancelSubscription(
  subscriptionId: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    await getStripe().subscriptions.cancel(subscriptionId);
    logger.info("Stripe subscription canceled", { subscriptionId, ...context });
    return true;
  } catch (err) {
    if (isAlreadyCanceled(err)) {
      logger.info("Stripe subscription was already gone", { subscriptionId, ...context });
      return true;
    }
    logger.error("Failed to cancel Stripe subscription", {
      subscriptionId,
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
