// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import Stripe from "stripe";
import { z } from "zod";
import { getStripe } from "./client.ts";
import { getEeDb } from "../db.ts";
import { billingAccounts, stripeEvents } from "../../drizzle/schema.ts";
import { and, eq, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { logger } from "../logger.ts";
import {
  getPlans,
  isPlanId,
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

// ---------------------------------------------------------------------------
// Subscription identity — which account a subscription-scoped event may write.
//
// Stripe guarantees NOTHING about delivery order, and `metadata.orgId` only says
// WHICH ORG a subscription belongs to, never that it is the one the org is
// paying on today. An org that replaced `sub_old` with `sub_new` still receives
// `sub_old`'s tail of events; matching on `orgId` alone let a
// `customer.subscription.deleted` for the DEAD subscription wipe the live one —
// plan back to free, quota to zero, subscription id to null — on an account
// Stripe is still billing. Reversed order and late delivery are the same fault
// wearing different hats.
//
// So every subscription-scoped write is pinned to the account that currently
// carries THAT subscription id. An event about any other subscription matches no
// row, changes nothing, and is logged. Event-id dedupe (`ee_stripe_events`) does
// not help here: each of these events is genuinely new and genuinely from
// Stripe — it is simply about a subscription the org has moved on from.
// ---------------------------------------------------------------------------

/** The org's account, but only while it still carries THIS subscription. */
function currentSubscription(orgId: string, subscriptionId: string): SQL {
  return and(
    eq(billingAccounts.orgId, orgId),
    eq(billingAccounts.stripeSubscriptionId, subscriptionId),
  )!;
}

/**
 * The predicate for the three handlers whose job includes ATTACHING a
 * subscription: checkout completion, subscription creation, and the first paid
 * invoice (which must not depend on winning the ordering race against them).
 *
 * An account qualifies when it carries no subscription, when it carries THIS
 * one, or when the id it carries names a subscription Stripe no longer holds
 * (`HELD_SUBSCRIPTION_STATUSES`). That last arm is what a stale id needs: only
 * `customer.subscription.deleted` nulls the column, so an org whose account sits
 * at `canceled` or `incomplete_expired` — or whose `deleted` event was lost —
 * still carries a dead id, and pinning on the id alone dropped its next paid
 * checkout as "superseded", leaving it charged with no plan and no quota.
 *
 * An account on a different subscription Stripe DOES hold is still excluded,
 * which is the whole point: that org is being billed for the row it carries, and
 * a replaced subscription's tail must not rewrite it.
 */
function attachableSubscription(orgId: string, subscriptionId: string): SQL {
  return and(
    eq(billingAccounts.orgId, orgId),
    or(
      isNull(billingAccounts.stripeSubscriptionId),
      eq(billingAccounts.stripeSubscriptionId, subscriptionId),
      // `NOT IN` is unknown against NULL, so the null status is its own arm.
      isNull(billingAccounts.subscriptionStatus),
      notInArray(billingAccounts.subscriptionStatus, [...HELD_SUBSCRIPTION_STATUSES]),
    ),
  )!;
}

/**
 * One line for an event that described a subscription this org is not on. `info`,
 * not `warn`: it is the expected tail of a replaced subscription, and the
 * alternative — acting on it — is what corrupts the account.
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

      const [linked] = await db
        .update(billingAccounts)
        .set({
          planId,
          creditQuota: plan.creditQuota,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: "active",
          updatedAt: new Date(),
        })
        // This is the handler that ATTACHES a subscription, so an account with
        // none — or with a dead id Stripe no longer holds — qualifies. An
        // account on a different LIVE subscription does not: a stale checkout
        // must not switch a paying org's plan.
        .where(attachableSubscription(orgId, subscriptionId))
        .returning({ orgId: billingAccounts.orgId });

      if (!linked) {
        logSupersededSubscription(event, orgId, subscriptionId);
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

      // Email: subscription confirmation — retrieve real period end from Stripe
      let checkoutPeriodEnd: Date | null = null;
      try {
        const sub = await getStripe().subscriptions.retrieve(subscriptionId);
        checkoutPeriodEnd = subscriptionPeriodEnd(sub);
      } catch {
        // Best-effort — send email without precise date if Stripe call fails
      }

      sendBillingEmail(orgId, "subscription-confirmed", {
        planName: plan.name,
        price: plan.monthlyPrice,
        periodEnd: (checkoutPeriodEnd ?? new Date()).toISOString(),
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

      // Attach only to an account Stripe holds no OTHER subscription for.
      // Read-then-write let a concurrent handler attach between the two; the
      // condition belongs in the UPDATE, where the row lock decides it.
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
        .where(attachableSubscription(orgId, subscription.id))
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

      // Also (re)establish the Stripe linkage here, on the shared attach
      // predicate, so allocation does not depend on checkout.session.completed
      // winning the ordering race. An account on a different subscription
      // Stripe still HOLDS is excluded: a late invoice for a replaced
      // subscription would otherwise re-attach the dead one and reset the live
      // plan's quota.
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
      if (newPlan) updates.planId = newPlan.id;

      // Resolve org from metadata (ordering-independent), then write only if the
      // org is still ON this subscription. Nothing here attaches one: checkout
      // completion, subscription creation and the first paid invoice do that, so
      // an `updated` for a subscription the account does not carry is either a
      // replaced subscription's tail or an event that arrived ahead of the
      // attachment — and in both cases the attaching handler carries the truth.
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
        // ONLY if this is still the org's subscription. Without it, the tail of
        // a replaced subscription tore down the live one: plan to free, quota to
        // zero, id to null — on an account Stripe was still charging.
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

        // A dunning notice for a subscription the org has replaced tells the
        // customer their live plan is failing to charge, which is false.
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
