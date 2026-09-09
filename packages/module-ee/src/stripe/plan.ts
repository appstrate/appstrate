// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { getStripe } from "./client.ts";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { eq } from "drizzle-orm";
import { getPlans, isPlanId, planAction } from "../config.ts";
import { noActiveSubscription, noBillingAccount } from "../http-errors.ts";
import { logger } from "../logger.ts";

/**
 * Move an EXISTING Stripe subscription onto another plan, in place. The counterpart of
 * `createCheckoutSession`: both refuse on {@link planAction}, so exactly one of the two
 * doors is open to any account. The single price item is swapped with
 * `create_prorations` and `metadata.planId` rewritten alongside it.
 *
 * WHAT THIS DOES NOT DO: write the plan onto the billing account. The
 * `customer.subscription.updated` handler is the single place a plan transition is
 * applied — two writers for one fact is how the account and Stripe drift apart.
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

  if (!account) throw noBillingAccount();

  const subscriptionId = account.stripeSubscriptionId;
  if (subscriptionId === null || planAction(account) !== "plan-change") {
    throw noActiveSubscription();
  }

  // The item id is required: `items: [{ price }]` without one ADDS a second priced item
  // instead of replacing the first — the same double-charge in a smaller package.
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
