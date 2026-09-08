// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { getStripe } from "./client.ts";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { getPlans, isPlanId, LIVE_SUBSCRIPTION_STATUSES } from "../config.ts";
import { noActiveSubscription } from "../http-errors.ts";
import { logger } from "../logger.ts";

/**
 * Move an EXISTING Stripe subscription onto another plan, in place.
 *
 * The counterpart of `createCheckoutSession`, which refuses an org that already
 * has a subscription. Checkout only creates; taking an upgrade through it left
 * the first subscription running beside the second and charged the customer
 * twice. Here the subscription's single price item is swapped instead, with
 * `create_prorations` so the customer is credited for the unused remainder of
 * the plan they are leaving and charged the difference for the one they enter —
 * Stripe's own arithmetic, not ours.
 *
 * The subscription's `metadata` is rewritten with the new `planId` in the same
 * call. It is not the source of truth (the price item is, everywhere it is read)
 * but leaving it frozen at the plan the org left makes every future dump of the
 * Stripe object lie about what happened here.
 *
 * WHAT THIS DOES NOT DO: write the plan onto the billing account. Stripe answers
 * with `customer.subscription.updated`, and that handler — which resolves the
 * plan from the live price item and now writes only to the account carrying this
 * exact subscription — is the single place a plan transition is applied. Two
 * writers for one fact is how the account and Stripe drift apart.
 */
export async function changeSubscriptionPlan(orgId: string, planId: string): Promise<void> {
  const plan = isPlanId(planId) ? getPlans()[planId] : undefined;
  if (!plan || !plan.stripePriceId) throw new Error(`Invalid plan: ${planId}`);

  const db = getEeDb();
  const [account] = await db
    .select({
      stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
      subscriptionStatus: billingAccounts.subscriptionStatus,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));

  if (!account) throw new Error(`No billing account for org: ${orgId}`);

  const subscriptionId = account.stripeSubscriptionId;
  if (
    subscriptionId === null ||
    account.subscriptionStatus === null ||
    !LIVE_SUBSCRIPTION_STATUSES.has(account.subscriptionStatus)
  ) {
    throw noActiveSubscription();
  }

  // The item id is required: `items: [{ price }]` without one ADDS a second
  // priced item to the subscription instead of replacing the first, which is the
  // same double-charge in a smaller package.
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId);
  const itemId = subscription.items?.data?.[0]?.id;
  if (!itemId) {
    throw new Error(`Stripe subscription ${subscriptionId} has no price item to move`);
  }

  await getStripe().subscriptions.update(subscriptionId, {
    items: [{ id: itemId, price: plan.stripePriceId }],
    proration_behavior: "create_prorations",
    metadata: { orgId, planId },
  });

  logger.info("Stripe subscription plan changed in place", { orgId, subscriptionId, planId });
}
