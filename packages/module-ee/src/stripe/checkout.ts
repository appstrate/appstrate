// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { getStripe } from "./client.ts";
import { getEeDb } from "../db.ts";
import { billingAccounts } from "../../drizzle/schema.ts";
import { and, eq, isNull } from "drizzle-orm";
import { getPlans, isPlanId, planAction } from "../config.ts";
import { resolvePrimaryBillingEmail } from "../billing/contact.ts";
import { noBillingAccount, subscriptionExists } from "../http-errors.ts";

/**
 * Start a Stripe Checkout for an org Stripe holds no subscription for.
 *
 * The test is {@link planAction}, the same predicate the billing snapshot
 * reports and `changeSubscriptionPlan` refuses on. The refusal lives here rather
 * than in the dashboard because a customer is protected from a double charge by
 * the server, not by which button the SPA renders.
 */
export async function createCheckoutSession(
  orgId: string,
  planId: string,
  appUrl: string,
  returnUrl?: string,
): Promise<string> {
  const plan = isPlanId(planId) ? getPlans()[planId] : undefined;
  if (!plan || !plan.stripePriceId) throw new Error(`Invalid plan: ${planId}`);

  const db = getEeDb();

  const [account] = await db
    .select({
      stripeCustomerId: billingAccounts.stripeCustomerId,
      stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
      subscriptionStatus: billingAccounts.subscriptionStatus,
      billingEmail: billingAccounts.billingEmail,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));

  if (!account) throw noBillingAccount();
  if (planAction(account) !== "checkout") throw subscriptionExists();

  // Get or create Stripe customer (conditional update prevents race condition)
  let customerId = account.stripeCustomerId;
  if (!customerId) {
    // The customer carries the billing contact so Stripe addresses its OWN
    // receipts and dunning mail — otherwise Stripe has no address at all and
    // every payment notice depends on EE noticing the webhook first.
    // `undefined`, not `null`: Stripe's API treats an absent field as "unset",
    // and an org whose owner the platform can no longer resolve still checks out.
    const email = await resolvePrimaryBillingEmail(orgId, account.billingEmail);
    const customer = await getStripe().customers.create({
      ...(email !== null && { email }),
      metadata: { orgId },
    });

    // Only set if still null — another concurrent request may have created one already
    const [updated] = await db
      .update(billingAccounts)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
      .where(and(eq(billingAccounts.orgId, orgId), isNull(billingAccounts.stripeCustomerId)))
      .returning({ stripeCustomerId: billingAccounts.stripeCustomerId });

    if (updated) {
      customerId = customer.id;
    } else {
      // Another request won the race — use the existing customer, delete the orphan
      const [existing] = await db
        .select({ stripeCustomerId: billingAccounts.stripeCustomerId })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));
      if (!existing?.stripeCustomerId) {
        throw new Error(`No Stripe customer for org after race resolution: ${orgId}`);
      }
      customerId = existing.stripeCustomerId;
      await getStripe()
        .customers.del(customer.id)
        .catch(() => {});
    }
  }

  const session = await getStripe().checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: returnUrl ? `${appUrl}${returnUrl}` : `${appUrl}/org-settings/billing`,
    cancel_url: returnUrl ? `${appUrl}${returnUrl}` : `${appUrl}/org-settings/billing`,
    subscription_data: {
      metadata: { orgId, planId },
    },
    metadata: { orgId, planId },
  });

  if (!session.url) {
    throw new Error("Stripe returned a session without a URL");
  }

  return session.url;
}
