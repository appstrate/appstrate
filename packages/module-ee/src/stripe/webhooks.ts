// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import Stripe from "stripe";
import { z } from "zod";
import { getStripe } from "./client.ts";
import { cancelSubscription } from "./cancel.ts";
import { getEeDb } from "../db.ts";
import { billingAccounts, stripeEvents } from "../../drizzle/schema.ts";
import { and, eq, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { logger } from "../logger.ts";
import {
  getPlans,
  isPlanId,
  ENDED_SUBSCRIPTION_STATUSES,
  HELD_SUBSCRIPTION_STATUSES,
  type Plans,
  type PlanDefinition,
} from "../config.ts";
import { getEeEnv } from "../env.ts";
import { sendBillingEmail } from "../emails/send.ts";
import { billingSettingsUrl } from "../emails/layout.ts";
import { getAppUrl } from "../platform.ts";
import { syncOrgStorageEntitlement } from "../billing/storage-entitlement.ts";

type BillingUpdate = Partial<typeof billingAccounts.$inferInsert>;

const CLAIM_TTL_MS = 5 * 60 * 1000; // 5 minutes

const stripeMetadataSchema = z.object({
  orgId: z.uuid(),
  planId: z.string().min(1),
});

function parseStripeMetadata(raw: Record<string, string> | null | undefined) {
  const result = stripeMetadataSchema.safeParse(raw ?? {});
  return result.success ? result.data : null;
}

// ---------------------------------------------------------------------------
// Resolution helpers — the single, shared way to derive billing facts from a
// Stripe object. Every handler routes through these so the rules live in ONE
// place:
//   • org   → ALWAYS `subscription.metadata.orgId` (stable for the sub's life,
//             ordering-independent). Pure customer-only events (no subscription
//             in payload) fall back to `stripeCustomerId`.
//   • plan  → ALWAYS the live price item, never `metadata.planId` (which freezes
//             at creation and goes stale after a Customer Portal plan change).
// ---------------------------------------------------------------------------

/** Narrow a Stripe "string id | expanded object | null" ref to its id string. */
function refId(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === "string" ? ref : ref.id;
}

/**
 * Live plan for a subscription = the plan whose configured Stripe price matches
 * the subscription's current price item. Authoritative over `metadata.planId`.
 */
function planForSubscription(
  subscription: Stripe.Subscription,
  plans: Plans,
): PlanDefinition | null {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  return Object.values(plans).find((p) => p?.stripePriceId === priceId) ?? null;
}

/** Current cycle end of a subscription, as a Date (null when absent). */
function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const ts = subscription.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}

// Subscription identity — which account a subscription-scoped event may write. Stripe
// guarantees no delivery order and `metadata.orgId` names the ORG, never that the org is
// still on that subscription, so every such write names the subscription it is about:
// on `orgId` alone a `deleted` for a replaced subscription wipes the live one.

/** The org's account, but only while it still carries THIS subscription. */
function currentSubscription(orgId: string, subscriptionId: string): SQL {
  return and(
    eq(billingAccounts.orgId, orgId),
    eq(billingAccounts.stripeSubscriptionId, subscriptionId),
  )!;
}

/**
 * An account Stripe holds no subscription for — free to take a new one. The id alone does
 * not decide it: only `customer.subscription.deleted` nulls the column, so a `canceled`
 * account keeps a dead id and refusing on it would drop the org's next paid checkout.
 */
function noHeldSubscription(): SQL {
  return or(
    isNull(billingAccounts.stripeSubscriptionId),
    // `NOT IN` is unknown against NULL, so the null status is its own arm.
    isNull(billingAccounts.subscriptionStatus),
    notInArray(billingAccounts.subscriptionStatus, [...HELD_SUBSCRIPTION_STATUSES]),
  )!;
}

/**
 * The predicate for `customer.subscription.created`, whose payload carries CREATION-time
 * state: it attaches only where nothing is held, so a late one rolls nothing back.
 */
function unattachedAccount(orgId: string): SQL {
  return and(eq(billingAccounts.orgId, orgId), noHeldSubscription())!;
}

/**
 * The predicate for `checkout.session.completed` and `invoice.paid`: they carry
 * AUTHORITATIVE data and also write the account already carrying that subscription.
 *
 * `noHeldSubscription()` deliberately matches a cancelled account, so this predicate alone
 * does NOT prove the subscription is alive — callers MUST first gate on the live object
 * from Stripe ({@link isEndedSubscription}), or a late event re-attaches a dead id.
 */
function attachableSubscription(orgId: string, subscriptionId: string): SQL {
  return and(
    eq(billingAccounts.orgId, orgId),
    or(noHeldSubscription(), eq(billingAccounts.stripeSubscriptionId, subscriptionId)),
  )!;
}

/**
 * A subscription Stripe will never bill again. The event payload cannot decide this — it
 * freezes at emission and Stripe guarantees no delivery order, so a `checkout.session.completed`
 * delivered after the cancellation still describes a live subscription. Only the retrieved
 * object does, which is why both attach paths retrieve before granting entitlements.
 */
function isEndedSubscription(subscription: Stripe.Subscription): boolean {
  return ENDED_SUBSCRIPTION_STATUSES.has(subscription.status);
}

/**
 * One line for an event on a subscription this org is not on — a replacement's tail. Log
 * only: a duplicate that is still billing came from a Checkout, and is cancelled by its own
 * `checkout.session.completed` ({@link reconcileSupersededCheckout}).
 */
function logSupersededSubscription(
  event: Stripe.Event,
  orgId: string,
  subscriptionId: string,
): void {
  logger.info("Stripe event skipped — subscription is not the org's current one", {
    eventId: event.id,
    type: event.type,
    orgId,
    subscriptionId,
  });
}

/** One line for an attach refused because Stripe no longer holds the subscription. */
function logEndedSubscription(
  event: Stripe.Event,
  orgId: string,
  subscription: Stripe.Subscription,
): void {
  logger.warn("Stripe event skipped — subscription has ended, no entitlement granted", {
    eventId: event.id,
    type: event.type,
    orgId,
    subscriptionId: subscription.id,
    status: subscription.status,
  });
}

/**
 * The subscription the org's account carries right now — null when nothing does, which
 * after a refused attach means the org has no billing row at all (every other shape
 * satisfies {@link attachableSubscription}).
 */
async function heldSubscriptionId(orgId: string): Promise<string | null> {
  const [account] = await getEeDb()
    .select({ stripeSubscriptionId: billingAccounts.stripeSubscriptionId })
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  return account?.stripeSubscriptionId ?? null;
}

/**
 * A paid checkout the org cannot be attached to, because another subscription already holds
 * the account. `createCheckoutSession` reads state Stripe writes only once a session is
 * PAID, so two sessions opened before either payment both pass its guard and Stripe bills
 * both. Only one can be the org's; the loser is cancelled here, because logging it leaves a
 * live subscription charging a customer that nothing in the product names, indefinitely.
 *
 * Cancels only against positive evidence of the winner — on no billing row there is no
 * duplicate to reconcile, and ending a paid subscription on that much would be guesswork.
 * A refused cancellation throws: the handler wrote nothing, so the dropped claim lets
 * Stripe's redelivery retry, and a cancel of an already-gone subscription is a no-op.
 */
async function reconcileSupersededCheckout(
  event: Stripe.Event,
  orgId: string,
  subscriptionId: string,
): Promise<void> {
  logSupersededSubscription(event, orgId, subscriptionId);

  // No winner to point at: no billing row (nothing to reconcile against), or a row already
  // on this very subscription (no duplicate at all) — neither justifies ending a paid one.
  const heldId = await heldSubscriptionId(orgId);
  if (heldId === null || heldId === subscriptionId) return;

  logger.warn("Duplicate paid subscription — cancelling the one that lost the attach", {
    eventId: event.id,
    orgId,
    subscriptionId,
    heldSubscriptionId: heldId,
  });

  if (!(await cancelSubscription(subscriptionId, { orgId, reason: "superseded-checkout" }))) {
    throw new Error(`Failed to cancel superseded subscription ${subscriptionId} for org ${orgId}`);
  }
}

export async function handleWebhook(body: string, signature: string): Promise<void> {
  const event = await getStripe().webhooks.constructEventAsync(
    body,
    signature,
    getEeEnv().STRIPE_WEBHOOK_SECRET,
  );

  // Idempotency via atomic claim: INSERT ... ON CONFLICT DO NOTHING.
  // If INSERT succeeds → exclusive right to process this event.
  // If INSERT fails (duplicate) → another handler already claimed it.
  const db = getEeDb();

  const [inserted] = await db
    .insert(stripeEvents)
    .values({ eventId: event.id, eventType: event.type, status: "processing" })
    .onConflictDoNothing({ target: stripeEvents.eventId })
    .returning({ eventId: stripeEvents.eventId });

  if (!inserted) {
    const [existing] = await db
      .select({ status: stripeEvents.status, claimedAt: stripeEvents.claimedAt })
      .from(stripeEvents)
      .where(eq(stripeEvents.eventId, event.id));

    if (existing?.status === "done") {
      return; // Already processed
    }

    // Stale claim — previous handler likely crashed
    if (existing && Date.now() - existing.claimedAt.getTime() > CLAIM_TTL_MS) {
      logger.warn("Reclaiming stale Stripe event (previous handler likely crashed)", {
        eventId: event.id,
        type: event.type,
      });
      await db.delete(stripeEvents).where(eq(stripeEvents.eventId, event.id));
      throw new Error(`Reclaimed stale event ${event.id} — will process on next Stripe retry`);
    }

    return; // Being processed by another handler
  }

  try {
    await processEvent(event);

    // Mark done only while the claim is still `processing`. This is a partial
    // guard, not a full claim-ownership check: it detects the common case where
    // OUR row was deleted by a stale-claim reclaim mid-processing (0 rows → we
    // log it). It does NOT distinguish our claim from a fresh reinserted one, so
    // the pathological interleave (handler runs > CLAIM_TTL, gets reclaimed, a
    // retry reinserts + reprocesses) is not fully prevented — fully closing it
    // needs a per-claim nonce column. Accepted: handlers are sub-second, so the
    // > 5-min window is effectively unreachable; most handlers are idempotent
    // (the subscription_cycle credit reset being the exception).
    const [confirmed] = await db
      .update(stripeEvents)
      .set({ status: "done", processedAt: new Date() })
      .where(and(eq(stripeEvents.eventId, event.id), eq(stripeEvents.status, "processing")))
      .returning({ eventId: stripeEvents.eventId });

    if (!confirmed) {
      logger.warn("Stripe event claim was reclaimed during processing — may reprocess on retry", {
        eventId: event.id,
        type: event.type,
      });
    }
  } catch (err) {
    // Delete claim to allow immediate retry by Stripe
    await db
      .delete(stripeEvents)
      .where(eq(stripeEvents.eventId, event.id))
      .catch(() => {});
    throw err;
  }
}

async function processEvent(event: Stripe.Event): Promise<void> {
  const db = getEeDb();
  const plans = getPlans();

  switch (event.type) {
    case "checkout.session.completed": {
      // Link the org to Stripe AND allocate the plan quota immediately. Quota is
      // also (re)set by invoice.paid, but allocating here removes the post-
      // checkout window where the org still carried its previous quota (free's
      // 5000, or 0 for a free-exhausted resubscriber). Critical for trials:
      // invoice.paid does not fire until the trial ends, so without this a
      // trialing paying customer would sit at quota 0. creditsUsed is left
      // untouched (only the renewal cycle resets it).
      const session = event.data.object;
      const metadata = parseStripeMetadata(session.metadata);
      if (!metadata) {
        logger.warn("Checkout completed with invalid metadata — possible misconfiguration", {
          eventId: event.id,
          metadata: session.metadata as Record<string, unknown>,
        });
        break;
      }
      const { orgId, planId } = metadata;

      const plan = isPlanId(planId) ? plans[planId] : undefined;
      if (!plan || !plan.stripePriceId) break;

      const customerId = refId(session.customer);
      const subscriptionId = refId(session.subscription);
      if (!customerId || !subscriptionId) {
        logger.warn("Checkout completed with non-string customer/subscription", {
          eventId: event.id,
          customerType: typeof session.customer,
          subscriptionType: typeof session.subscription,
        });
        break;
      }

      // The session froze at completion; Stripe may have cancelled the subscription since
      // (deliveries are unordered). Retrieve the live object BEFORE granting: throwing on
      // failure deletes the claim so Stripe retries, as on the invoice.paid path — the
      // grant is billing-critical and must not proceed on unverified state.
      let checkoutSubscription: Stripe.Subscription;
      try {
        checkoutSubscription = await getStripe().subscriptions.retrieve(subscriptionId);
      } catch (err) {
        logger.error("Failed to retrieve subscription for checkout attach", {
          eventId: event.id,
          subscriptionId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (isEndedSubscription(checkoutSubscription)) {
        logEndedSubscription(event, orgId, checkoutSubscription);
        break;
      }

      const [linked] = await db
        .update(billingAccounts)
        .set({
          planId,
          creditQuota: plan.creditQuota,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          // The live status, not a hardcoded "active": a checkout that opens a trial is
          // `trialing`, and the row must not claim a state Stripe does not hold.
          subscriptionStatus: checkoutSubscription.status,
          updatedAt: new Date(),
        })
        .where(attachableSubscription(orgId, subscriptionId))
        .returning({ orgId: billingAccounts.orgId });

      if (!linked) {
        await reconcileSupersededCheckout(event, orgId, subscriptionId);
        break;
      }

      logger.info("Checkout completed — org linked + quota allocated", {
        orgId,
        planId,
        creditQuota: plan.creditQuota,
      });

      // Project the new plan onto the platform storage limit (best-effort —
      // the periodic resync repairs a miss).
      await syncOrgStorageEntitlement(orgId);

      sendBillingEmail(orgId, "subscription-confirmed", {
        planName: plan.name,
        price: plan.monthlyPrice,
        periodEnd: (subscriptionPeriodEnd(checkoutSubscription) ?? new Date()).toISOString(),
        locale: "fr",
      });
      break;
    }

    case "customer.subscription.created": {
      // Safety net: captures subscriptions created outside Checkout flow
      const subscription = event.data.object;
      const subMetadata = parseStripeMetadata(subscription.metadata);
      if (!subMetadata) {
        logger.warn("Subscription created with invalid metadata", { eventId: event.id });
        break;
      }
      const { orgId } = subMetadata;

      const subCustomerId = refId(subscription.customer);
      if (!subCustomerId) {
        logger.warn("Subscription created with non-string customer", {
          eventId: event.id,
          customerType: typeof subscription.customer,
        });
        break;
      }

      const plan = planForSubscription(subscription, plans);
      const planId = plan?.id ?? subMetadata.planId;

      // The condition rides in the UPDATE, where the row lock decides it: a read-then-write
      // lets a concurrent handler attach between the two.
      const [linked] = await db
        .update(billingAccounts)
        .set({
          planId,
          // Allocate quota here too (trial / non-checkout path), so a
          // subscription that never goes through checkout.session.completed
          // still gets its plan budget before the first invoice.paid.
          ...(plan ? { creditQuota: plan.creditQuota } : {}),
          stripeCustomerId: subCustomerId,
          stripeSubscriptionId: subscription.id,
          subscriptionStatus: subscription.status,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          updatedAt: new Date(),
        })
        .where(unattachedAccount(orgId))
        .returning({ orgId: billingAccounts.orgId });

      if (!linked) {
        logSupersededSubscription(event, orgId, subscription.id);
        break;
      }

      logger.info("Subscription created (non-Checkout path) — org linked to Stripe", {
        orgId,
        planId,
        status: subscription.status,
      });

      await syncOrgStorageEntitlement(orgId);
      break;
    }

    case "invoice.paid": {
      // Single source of budget allocation (first payment + renewals).
      //
      // Org resolution: via the SUBSCRIPTION's metadata, not the billing
      // account's stripeCustomerId. Stripe does not guarantee webhook delivery
      // order, so checkout.session.completed (which writes stripeCustomerId)
      // may not have been processed when invoice.paid arrives. orgId is stable
      // on the subscription for its whole life, so this is ordering-independent.
      //
      // Plan resolution: from the subscription's PRICE ID, not metadata.planId.
      // metadata is frozen at creation — a Customer Portal plan change swaps the
      // price item but leaves metadata.planId stale. The price id is the live
      // source of truth (same approach as customer.subscription.updated).
      const invoice = event.data.object;

      const subscriptionRef = invoice.parent?.subscription_details?.subscription;
      if (!subscriptionRef) {
        logger.warn("Invoice has no subscription reference, skipping budget allocation", {
          eventId: event.id,
          invoiceId: invoice.id,
        });
        break;
      }

      let subscription: Stripe.Subscription;
      try {
        subscription = await getStripe().subscriptions.retrieve(refId(subscriptionRef)!);
      } catch (err) {
        // Throw — deletes the claim so Stripe retries. Budget allocation is the
        // billing-critical path; a silent break would lose the grant entirely.
        logger.error("Failed to retrieve subscription for budget allocation", {
          eventId: event.id,
          invoiceId: invoice.id,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      const metadata = parseStripeMetadata(subscription.metadata);
      if (!metadata) {
        logger.warn("Subscription has invalid metadata, skipping budget allocation", {
          eventId: event.id,
          subscriptionId: subscription.id,
        });
        break;
      }
      const { orgId } = metadata;

      // Same guard as the checkout attach: an invoice settled after the cancellation must
      // not re-attach the dead subscription with a fresh quota.
      if (isEndedSubscription(subscription)) {
        logEndedSubscription(event, orgId, subscription);
        break;
      }

      const plan = planForSubscription(subscription, plans);
      if (!plan) {
        logger.warn("No plan matches subscription price, skipping budget allocation", {
          orgId,
          subscriptionId: subscription.id,
        });
        break;
      }

      const invoiceCustomerId = refId(invoice.customer);

      // Renewal (subscription_cycle): reset creditsUsed to 0. Otherwise OMIT the
      // column entirely — never write back a previously-read value, which would
      // clobber a billing-sweep debit that committed in the read→write gap.
      const resetCredits = invoice.billing_reason === "subscription_cycle";

      // (Re)establishes the Stripe linkage on the shared attach predicate, so allocation
      // does not depend on `checkout.session.completed` winning the ordering race.
      const [allocated] = await db
        .update(billingAccounts)
        .set({
          planId: plan.id,
          ...(resetCredits ? { creditsUsed: 0 } : {}),
          creditQuota: plan.creditQuota,
          periodEnd: subscriptionPeriodEnd(subscription),
          // Invoice paid = subscription is current
          subscriptionStatus: "active",
          stripeSubscriptionId: subscription.id,
          ...(invoiceCustomerId ? { stripeCustomerId: invoiceCustomerId } : {}),
          updatedAt: new Date(),
        })
        .where(attachableSubscription(orgId, subscription.id))
        .returning({ orgId: billingAccounts.orgId });

      if (!allocated) {
        logSupersededSubscription(event, orgId, subscription.id);
        break;
      }

      logger.info("Credits allocated via invoice.paid", {
        orgId,
        planId: plan.id,
        creditsReset: resetCredits,
        creditQuota: plan.creditQuota,
        billingReason: invoice.billing_reason,
      });

      await syncOrgStorageEntitlement(orgId);

      // Email: payment receipt
      const amountPaid = (invoice.amount_paid ?? 0) / 100; // cents → dollars
      sendBillingEmail(orgId, "payment-receipt", {
        planName: plan.name,
        amount: amountPaid,
        invoiceUrl: invoice.hosted_invoice_url ?? null,
        periodEnd: (subscriptionPeriodEnd(subscription) ?? new Date()).toISOString(),
        locale: "fr",
      });
      break;
    }

    case "customer.subscription.updated": {
      // Handles: plan changes, status transitions, cancel_at_period_end, pause/resume
      const subscription = event.data.object;
      const subMetadata = parseStripeMetadata(subscription.metadata);
      if (!subMetadata) {
        logger.warn("Subscription updated with invalid metadata", {
          eventId: event.id,
          subscriptionId: subscription.id,
        });
        break;
      }
      const { orgId } = subMetadata;

      const previousAttributes = (event.data as { previous_attributes?: Record<string, unknown> })
        .previous_attributes;
      const itemPeriodEnd = subscriptionPeriodEnd(subscription);
      const newPlan = planForSubscription(subscription, plans);

      // Always sync status + cancel flag; sync period/plan when present.
      const updates: BillingUpdate = {
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        updatedAt: new Date(),
      };
      if (itemPeriodEnd) updates.periodEnd = itemPeriodEnd;
      if (newPlan) {
        updates.planId = newPlan.id;
        // The plan and its ceiling are ONE fact: `changeSubscriptionPlan` deliberately
        // writes neither, and `create_prorations` bills on the next cycle, so no
        // `invoice.paid` follows a plan switch to repair a stale quota.
        //
        // `creditsUsed` is deliberately left alone — consumption already billed is never
        // erased by a plan move (same rule as invoice.paid outside `subscription_cycle`).
        // An upgrade therefore frees exactly the added headroom, and a downgrade below
        // current consumption leaves the account over its ceiling until the renewal
        // invoice resets the counter.
        updates.creditQuota = newPlan.creditQuota;
      }

      // Org from metadata (ordering-independent), written only if the org is still ON this
      // subscription. Nothing here ATTACHES one, so an `updated` naming another is a tail.
      const [updated] = await db
        .update(billingAccounts)
        .set(updates)
        .where(currentSubscription(orgId, subscription.id))
        .returning({ orgId: billingAccounts.orgId });

      if (!updated) {
        logSupersededSubscription(event, orgId, subscription.id);
        break;
      }

      logger.info("Subscription updated", {
        subscriptionId: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        planId: newPlan?.id,
      });

      // Plan may have changed (Customer Portal switch) — re-project storage.
      await syncOrgStorageEntitlement(orgId);

      const accessUntil = (itemPeriodEnd ?? new Date()).toISOString();

      // Email: cancellation confirmed (cancel_at_period_end just turned true)
      if (
        subscription.cancel_at_period_end &&
        previousAttributes &&
        "cancel_at_period_end" in previousAttributes &&
        !previousAttributes.cancel_at_period_end
      ) {
        sendBillingEmail(orgId, "cancellation-confirmed", {
          planName: newPlan?.name ?? subMetadata.planId,
          accessUntil,
          locale: "fr",
        });
      }

      // Email: plan changed (price changed, not a cancellation)
      if (
        newPlan &&
        previousAttributes &&
        "items" in previousAttributes &&
        !subscription.cancel_at_period_end
      ) {
        const previousPriceId = (
          previousAttributes.items as { data?: Array<{ price?: { id?: string } }> }
        )?.data?.[0]?.price?.id;
        const oldPlan = Object.values(plans).find((p) => p?.stripePriceId === previousPriceId);

        if (oldPlan && oldPlan.id !== newPlan.id) {
          sendBillingEmail(orgId, "plan-changed", {
            oldPlanName: oldPlan.name,
            newPlanName: newPlan.name,
            newPrice: newPlan.monthlyPrice,
            effectiveDate: accessUntil,
            locale: "fr",
          });
        }
      }
      break;
    }

    case "customer.subscription.deleted": {
      // Terminal cancellation — subscription is gone, downgrade to free with 0 credits.
      // Credits are NOT re-granted here to prevent subscribe→cancel abuse loops.
      // Users who need free tier credits again must contact support.
      const subscription = event.data.object;
      const subMetadata = parseStripeMetadata(subscription.metadata);
      if (!subMetadata) {
        logger.warn("Subscription deleted with invalid metadata", {
          eventId: event.id,
          subscriptionId: subscription.id,
        });
        break;
      }
      const { orgId } = subMetadata;

      const [deleted] = await db
        .update(billingAccounts)
        .set({
          planId: "free",
          stripeSubscriptionId: null,
          periodEnd: null,
          // No subscription remains attached. `null` is the canonical free-tier
          // state; the Stripe event log retains the terminal cancellation fact.
          subscriptionStatus: null,
          cancelAtPeriodEnd: false,
          creditsUsed: 0,
          creditQuota: 0,
          updatedAt: new Date(),
        })
        // ONLY if this is still the org's subscription: a replacement's tail would
        // otherwise tear the live one down on an account Stripe charges.
        .where(currentSubscription(orgId, subscription.id))
        .returning({ orgId: billingAccounts.orgId });

      if (!deleted) {
        logSupersededSubscription(event, orgId, subscription.id);
        break;
      }

      logger.info("Subscription deleted — downgraded to free with 0 credits", {
        subscriptionId: subscription.id,
        orgId,
      });

      // Storage follows the plan, not the credit anti-abuse rule: the org
      // drops to the free-plan ceiling (existing documents are never evicted;
      // the platform only blocks new writes above the limit).
      await syncOrgStorageEntitlement(orgId);

      // Email: subscription expired
      sendBillingEmail(orgId, "subscription-expired", {
        resubscribeUrl: billingSettingsUrl(getAppUrl()),
        locale: "fr",
      });
      break;
    }

    // Note: customer.subscription.paused and .resumed are covered by
    // customer.subscription.updated which syncs subscriptionStatus on every change.

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const failedCustomerId = refId(invoice.customer);

      logger.warn("Invoice payment failed — Stripe will retry per dunning settings", {
        customerId: failedCustomerId,
        invoiceId: invoice.id,
        billingReason: invoice.billing_reason,
      });

      // Email: payment failed with dunning escalation
      if (failedCustomerId) {
        const [failedAccount] = await db
          .select({
            orgId: billingAccounts.orgId,
            planId: billingAccounts.planId,
            stripeSubscriptionId: billingAccounts.stripeSubscriptionId,
          })
          .from(billingAccounts)
          .where(eq(billingAccounts.stripeCustomerId, failedCustomerId));

        // A dunning notice for a replaced subscription would tell the customer their live
        // plan is failing to charge, which is false.
        const failedSubscriptionId = refId(invoice.parent?.subscription_details?.subscription);
        if (
          failedAccount &&
          failedSubscriptionId !== null &&
          failedAccount.stripeSubscriptionId !== failedSubscriptionId
        ) {
          logSupersededSubscription(event, failedAccount.orgId, failedSubscriptionId);
          break;
        }

        if (failedAccount) {
          const plan = isPlanId(failedAccount.planId) ? plans[failedAccount.planId] : undefined;
          const amountDue = (invoice.amount_due ?? 0) / 100;
          const attemptCount = invoice.attempt_count ?? 1;

          sendBillingEmail(failedAccount.orgId, "payment-failed", {
            planName: plan?.name ?? failedAccount.planId,
            amount: amountDue,
            attemptNumber: attemptCount,
            updateUrl: billingSettingsUrl(getAppUrl()),
            locale: "fr",
          });
        }
      }
      break;
    }

    case "customer.source.expiring": {
      // Pre-dunning: card expiring soon (sent ~30 days before expiry by Stripe)
      const source = event.data.object as Stripe.Card;
      const expiringCustomerId = refId(source.customer);

      if (expiringCustomerId) {
        const [expiringAccount] = await db
          .select({ orgId: billingAccounts.orgId })
          .from(billingAccounts)
          .where(eq(billingAccounts.stripeCustomerId, expiringCustomerId));

        if (expiringAccount) {
          sendBillingEmail(expiringAccount.orgId, "card-expiring", {
            cardLast4: source.last4 ?? "????",
            expiryMonth: `${String(source.exp_month).padStart(2, "0")}/${String(source.exp_year).slice(-2)}`,
            updateUrl: billingSettingsUrl(getAppUrl()),
            locale: "fr",
          });
        }
      }
      break;
    }

    case "charge.dispute.created": {
      const dispute = event.data.object;
      logger.warn("Stripe dispute created — manual review required", {
        disputeId: dispute.id,
        amount: dispute.amount,
        reason: dispute.reason,
        chargeId: refId(dispute.charge),
      });
      break;
    }

    default:
      logger.debug("Unhandled Stripe event type", { type: event.type, eventId: event.id });
  }
}
