// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { truncateEeTables, getEeDb } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import {
  resetStripeMock,
  generateWebhookEvent,
  setSubscriptionResponse,
  invoiceEventObject,
  requests,
  type Fixture,
} from "../../helpers/stripe.ts";
import { handleWebhook } from "../../../src/stripe/webhooks.ts";
import { billingAccounts, stripeEvents } from "../../../drizzle/schema.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

const WEBHOOK_SECRET = "whsec_test_secret_for_webhook_verification";

describe("handleWebhook", () => {
  const orgId = "00000000-0000-4000-a000-000000000040";

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
  });

  function signedEvent(payload: object) {
    return generateWebhookEvent(payload, WEBHOOK_SECRET);
  }

  function signedCreatedEvent(id: string, subscription: Fixture<Stripe.Subscription>) {
    setSubscriptionResponse(subscription);
    return signedEvent({
      id,
      type: "customer.subscription.created",
      data: { object: subscription },
    });
  }

  describe("checkout.session.completed", () => {
    it("updates planId, stripeCustomerId, stripeSubscriptionId, status, and allocates quota", async () => {
      await seedBillingAccount({ orgId, creditQuota: 0 });

      const { body, signature } = signedEvent({
        id: "evt_checkout_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_checkout_001",
            subscription: "sub_checkout_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("starter");
      expect(account!.stripeCustomerId).toBe("cus_checkout_001");
      expect(account!.stripeSubscriptionId).toBe("sub_checkout_001");
      expect(account!.subscriptionStatus).toBe("active");
      // Quota allocated immediately at checkout (no wait for invoice.paid).
      expect(account!.creditQuota).toBe(20000);
    });

    it("refuses to attach a subscription Stripe has already cancelled", async () => {
      // Post-`customer.subscription.deleted` state: free, no held subscription, 0 credits.
      await seedBillingAccount({
        orgId,
        planId: "free",
        stripeCustomerId: "cus_dead_001",
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        creditQuota: 0,
      });

      // The session froze before the cancellation; Stripe's live object says otherwise.
      setSubscriptionResponse({
        id: "sub_dead_001",
        object: "subscription",
        status: "canceled",
        metadata: { orgId, planId: "starter" },
        items: { object: "list", data: [{ id: "si_dead", price: { id: "price_starter_test" } }] },
      });

      const { body, signature } = signedEvent({
        id: "evt_checkout_dead_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_dead_001",
            subscription: "sub_dead_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("free");
      expect(account!.stripeSubscriptionId).toBeNull();
      expect(account!.subscriptionStatus).toBeNull();
      expect(account!.creditQuota).toBe(0);
    });

    it("records the live subscription status, not a hardcoded active", async () => {
      await seedBillingAccount({ orgId, creditQuota: 0 });

      setSubscriptionResponse({
        id: "sub_trial_001",
        object: "subscription",
        status: "trialing",
        metadata: { orgId, planId: "starter" },
        items: { object: "list", data: [{ id: "si_trial", price: { id: "price_starter_test" } }] },
      });

      const { body, signature } = signedEvent({
        id: "evt_checkout_trial_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_trial_checkout_001",
            subscription: "sub_trial_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.subscriptionStatus).toBe("trialing");
      expect(account!.stripeSubscriptionId).toBe("sub_trial_001");
      expect(account!.creditQuota).toBe(20000);
    });

    it("cancels a duplicate paid subscription the account cannot be attached to", async () => {
      // Two Checkout sessions opened before either was paid; the first one paid won the row.
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_dup_001",
        stripeSubscriptionId: "sub_dup_winner",
        subscriptionStatus: "active",
        creditQuota: 20000,
      });

      setSubscriptionResponse({
        id: "sub_dup_loser",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: { object: "list", data: [{ id: "si_dup", price: { id: "price_starter_test" } }] },
      });

      const { body, signature } = signedEvent({
        id: "evt_checkout_dup_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_dup_001",
            subscription: "sub_dup_loser",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      // The winner keeps the account untouched...
      expect(account!.stripeSubscriptionId).toBe("sub_dup_winner");
      expect(account!.subscriptionStatus).toBe("active");
      // ...and the loser is no longer billing the customer.
      expect(requests).toContainEqual({
        method: "DELETE",
        path: "/v1/subscriptions/sub_dup_loser",
        body: null,
      });
    });

    it("does not cancel when the refusal names no winner — the org has no billing row", async () => {
      setSubscriptionResponse({
        id: "sub_orphan_001",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: { object: "list", data: [{ id: "si_orphan", price: { id: "price_starter_test" } }] },
      });

      const { body, signature } = signedEvent({
        id: "evt_checkout_orphan_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_orphan_001",
            subscription: "sub_orphan_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      expect(requests.filter((r) => r.method === "DELETE")).toEqual([]);
    });
  });

  describe("customer.subscription.created", () => {
    it("stores subscription if account has no subscriptionId yet", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_sub_created_001",
        stripeSubscriptionId: null,
      });

      const { body, signature } = signedCreatedEvent("evt_sub_created_001", {
        id: "sub_created_001",
        customer: "cus_sub_created_001",
        status: "active",
        cancel_at_period_end: false,
        metadata: { orgId, planId: "starter" },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.stripeSubscriptionId).toBe("sub_created_001");
      expect(account!.planId).toBe("starter");
      expect(account!.subscriptionStatus).toBe("active");
    });

    it("allocates quota for a trialing subscription (before any invoice.paid)", async () => {
      await seedBillingAccount({
        orgId,
        creditQuota: 0,
        stripeCustomerId: "cus_trial_001",
        stripeSubscriptionId: null,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
      const { body, signature } = signedCreatedEvent("evt_sub_trial_001", {
        id: "sub_trial_001",
        customer: "cus_trial_001",
        status: "trialing",
        cancel_at_period_end: false,
        metadata: { orgId, planId: "starter" },
        items: {
          data: [
            {
              id: "si_trial",
              current_period_end: periodEnd,
              price: { id: "price_starter_test" },
            },
          ],
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.subscriptionStatus).toBe("trialing");
      expect(account!.creditQuota).toBe(20000);
    });

    it("leaves the account alone when it already carries THIS subscription", async () => {
      // Stripe orders nothing, so `created` can land after `checkout.session.completed`
      // or an `updated`. Its payload is creation-time state, so writing it would roll
      // back the live status and cancel flag of the subscription the org is on.
      await seedBillingAccount({
        orgId,
        planId: "pro",
        stripeCustomerId: "cus_late_created",
        stripeSubscriptionId: "sub_new",
        subscriptionStatus: "active",
        cancelAtPeriodEnd: false,
        creditQuota: 80000,
      });

      const { body, signature } = signedCreatedEvent("evt_late_created", {
        id: "sub_new",
        customer: "cus_late_created",
        status: "incomplete",
        cancel_at_period_end: true,
        metadata: { orgId, planId: "starter" },
        items: { data: [{ id: "si_new", price: { id: "price_starter_test" } }] },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.subscriptionStatus).toBe("active");
      expect(account!.cancelAtPeriodEnd).toBe(false);
      expect(account!.planId).toBe("pro");
      expect(account!.creditQuota).toBe(80000);
    });

    it("attaches over an id the account carries with no status at all", async () => {
      // Only `customer.subscription.deleted` nulls the id column, so an account with an
      // id and no status has nothing Stripe holds and must not be locked out.
      await seedBillingAccount({
        orgId,
        planId: "free",
        stripeCustomerId: "cus_statusless",
        stripeSubscriptionId: "sub_statusless",
        subscriptionStatus: null,
        creditQuota: 0,
      });

      const { body, signature } = signedCreatedEvent("evt_created_over_statusless", {
        id: "sub_fresh",
        customer: "cus_statusless",
        status: "active",
        cancel_at_period_end: false,
        metadata: { orgId, planId: "starter" },
        items: { data: [{ id: "si_fresh", price: { id: "price_starter_test" } }] },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.stripeSubscriptionId).toBe("sub_fresh");
      expect(account!.planId).toBe("starter");
      expect(account!.creditQuota).toBe(20000);
    });
  });

  describe("invoice.paid", () => {
    it("resets creditsUsed to 0 on subscription_cycle (renewal)", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_invoice_001",
        stripeSubscriptionId: "sub_invoice_001",
        subscriptionStatus: "active",
        creditsUsed: 1500,
        creditQuota: 20000,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      setSubscriptionResponse({
        id: "sub_invoice_001",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: {
          object: "list",
          data: [
            {
              id: "si_001",
              current_period_end: periodEnd,
              price: { id: "price_starter_test" },
            },
          ],
        },
      });

      const { body, signature } = signedEvent({
        id: "evt_invoice_cycle_001",
        type: "invoice.paid",
        data: {
          object: invoiceEventObject({
            id: "in_cycle_001",
            customer: "cus_invoice_001",
            subscription: "sub_invoice_001",
            billingReason: "subscription_cycle",
          }),
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.creditsUsed).toBe(0);
      expect(account!.creditQuota).toBe(20000);
      expect(account!.subscriptionStatus).toBe("active");
    });

    it("preserves creditsUsed on subscription_create (initial payment)", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_invoice_002",
        stripeSubscriptionId: "sub_invoice_002",
        subscriptionStatus: "active",
        creditsUsed: 500,
        creditQuota: 5000,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      setSubscriptionResponse({
        id: "sub_invoice_002",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: {
          object: "list",
          data: [
            {
              id: "si_002",
              current_period_end: periodEnd,
              price: { id: "price_starter_test" },
            },
          ],
        },
      });

      const { body, signature } = signedEvent({
        id: "evt_invoice_create_001",
        type: "invoice.paid",
        data: {
          object: invoiceEventObject({
            id: "in_create_001",
            customer: "cus_invoice_002",
            subscription: "sub_invoice_002",
            billingReason: "subscription_create",
          }),
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.creditsUsed).toBe(500);
      expect(account!.creditQuota).toBe(20000);
    });

    it("grants nothing when the paid invoice belongs to a cancelled subscription", async () => {
      await seedBillingAccount({
        orgId,
        planId: "free",
        stripeCustomerId: "cus_invoice_dead",
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        creditsUsed: 0,
        creditQuota: 0,
      });

      setSubscriptionResponse({
        id: "sub_invoice_dead",
        object: "subscription",
        status: "canceled",
        metadata: { orgId, planId: "starter" },
        items: { object: "list", data: [{ id: "si_dead", price: { id: "price_starter_test" } }] },
      });

      const { body, signature } = signedEvent({
        id: "evt_invoice_dead_001",
        type: "invoice.paid",
        data: {
          object: invoiceEventObject({
            id: "in_dead_001",
            customer: "cus_invoice_dead",
            subscription: "sub_invoice_dead",
            billingReason: "subscription_cycle",
          }),
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("free");
      expect(account!.stripeSubscriptionId).toBeNull();
      expect(account!.creditQuota).toBe(0);
    });
  });

  describe("ordering + plan resolution (regression)", () => {
    it("allocates budget when invoice.paid is processed before checkout.session.completed", async () => {
      // Fresh account as left by onOrgCreate: free plan, no Stripe linkage yet.
      // invoice.paid must self-resolve org (subscription metadata) + plan (price)
      // and establish the linkage — without depending on checkout running first.
      await seedBillingAccount({
        orgId,
        planId: "free",
        creditQuota: 5000,
        creditsUsed: 0,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      setSubscriptionResponse({
        id: "sub_race_001",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: {
          object: "list",
          data: [
            { id: "si_race", current_period_end: periodEnd, price: { id: "price_starter_test" } },
          ],
        },
      });

      const { body, signature } = signedEvent({
        id: "evt_race_invoice_001",
        type: "invoice.paid",
        data: {
          object: invoiceEventObject({
            id: "in_race_001",
            customer: "cus_race_001",
            subscription: "sub_race_001",
            billingReason: "subscription_create",
          }),
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("starter");
      expect(account!.creditQuota).toBe(20000);
      expect(account!.stripeSubscriptionId).toBe("sub_race_001");
      expect(account!.stripeCustomerId).toBe("cus_race_001");
      expect(account!.subscriptionStatus).toBe("active");
    });

    it("derives plan from the live price item, not stale subscription.metadata.planId", async () => {
      // Portal upgrade leaves subscription.metadata.planId frozen at "starter"
      // while the price item moves to pro. The price must win.
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_portal_001",
        stripeSubscriptionId: "sub_portal_001",
        subscriptionStatus: "active",
        creditsUsed: 0,
        creditQuota: 20000,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      setSubscriptionResponse({
        id: "sub_portal_001",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: {
          object: "list",
          data: [
            { id: "si_portal", current_period_end: periodEnd, price: { id: "price_pro_test" } },
          ],
        },
      });

      const { body, signature } = signedEvent({
        id: "evt_portal_invoice_001",
        type: "invoice.paid",
        data: {
          object: invoiceEventObject({
            id: "in_portal_001",
            customer: "cus_portal_001",
            subscription: "sub_portal_001",
            billingReason: "subscription_update",
          }),
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("pro");
      expect(account!.creditQuota).toBe(80000);
    });
  });

  describe("customer.subscription.updated", () => {
    it("updates planId, status, and cancelAtPeriodEnd", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_update_001",
        stripeSubscriptionId: "sub_update_001",
        subscriptionStatus: "active",
      });

      const { body, signature } = signedEvent({
        id: "evt_sub_updated_001",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_update_001",
            status: "past_due",
            cancel_at_period_end: true,
            metadata: { orgId, planId: "starter" },
            items: {
              data: [
                {
                  id: "si_upd_001",
                  price: { id: "price_pro_test" },
                  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
                },
              ],
            },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("pro");
      expect(account!.subscriptionStatus).toBe("past_due");
      expect(account!.cancelAtPeriodEnd).toBe(true);
    });

    it("raises the credit quota on an upgrade, freeing the added headroom", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_update_002",
        stripeSubscriptionId: "sub_update_002",
        subscriptionStatus: "active",
        creditsUsed: 20000,
        creditQuota: 20000,
      });

      const { body, signature } = signedEvent({
        id: "evt_sub_updated_upgrade",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_update_002",
            status: "active",
            cancel_at_period_end: false,
            metadata: { orgId, planId: "pro" },
            items: {
              data: [
                {
                  id: "si_upd_002",
                  price: { id: "price_pro_test" },
                  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
                },
              ],
            },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("pro");
      expect(account!.creditQuota).toBe(80000);
      // Consumption already billed survives the move — the upgrade buys headroom,
      // it does not erase the Starter spend.
      expect(account!.creditsUsed).toBe(20000);
    });

    it("lowers the credit quota on a downgrade without erasing consumption", async () => {
      await seedBillingAccount({
        orgId,
        planId: "pro",
        stripeCustomerId: "cus_update_003",
        stripeSubscriptionId: "sub_update_003",
        subscriptionStatus: "active",
        creditsUsed: 60000,
        creditQuota: 80000,
      });

      const { body, signature } = signedEvent({
        id: "evt_sub_updated_downgrade",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_update_003",
            status: "active",
            cancel_at_period_end: false,
            metadata: { orgId, planId: "starter" },
            items: {
              data: [
                {
                  id: "si_upd_003",
                  price: { id: "price_starter_test" },
                  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
                },
              ],
            },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("starter");
      expect(account!.creditQuota).toBe(20000);
      // Over the new ceiling on purpose: the renewal invoice resets the counter,
      // a plan move never grants credits back.
      expect(account!.creditsUsed).toBe(60000);
    });
  });

  describe("customer.subscription.deleted", () => {
    it("downgrades to free with 0 credits and no attached subscription", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_delete_001",
        stripeSubscriptionId: "sub_delete_001",
        subscriptionStatus: "active",
        creditsUsed: 1000,
        creditQuota: 20000,
      });

      const { body, signature } = signedEvent({
        id: "evt_sub_deleted_001",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_delete_001",
            customer: "cus_delete_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("free");
      expect(account!.stripeSubscriptionId).toBeNull();
      expect(account!.subscriptionStatus).toBeNull();
      expect(account!.cancelAtPeriodEnd).toBe(false);
      expect(account!.creditsUsed).toBe(0);
      expect(account!.creditQuota).toBe(0);
      expect(account!.periodEnd).toBeNull();
    });
  });

  describe("invoice.payment_failed", () => {
    it("does not modify the billing account", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_fail_001",
        stripeSubscriptionId: "sub_fail_001",
        subscriptionStatus: "active",
        creditsUsed: 1000,
        creditQuota: 20000,
      });

      const { body, signature } = signedEvent({
        id: "evt_payment_failed_001",
        type: "invoice.payment_failed",
        data: {
          object: invoiceEventObject({
            id: "in_fail_001",
            customer: "cus_fail_001",
            subscription: null,
            billingReason: "subscription_cycle",
          }),
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.planId).toBe("starter");
      expect(account!.creditsUsed).toBe(1000);
      expect(account!.creditQuota).toBe(20000);
      expect(account!.subscriptionStatus).toBe("active");
    });
  });

  describe("subscription identity — an event may only act on the current subscription", () => {
    // An org that replaced `sub_old` with `sub_new` still receives `sub_old`'s tail, and
    // `metadata.orgId` is identical on both. Event-id dedupe cannot help: these events
    // are new, real, and about a subscription that no longer matters.

    async function account() {
      const db = getEeDb();
      const [row] = await db.select().from(billingAccounts).where(eq(billingAccounts.orgId, orgId));
      return row!;
    }

    async function seedReplacedSubscription() {
      await seedBillingAccount({
        orgId,
        planId: "pro",
        stripeCustomerId: "cus_identity",
        stripeSubscriptionId: "sub_new",
        subscriptionStatus: "active",
        creditsUsed: 1000,
        creditQuota: 80000,
      });
    }

    it("REGRESSION: deleting the OLD subscription leaves the active replacement alone", async () => {
      await seedReplacedSubscription();

      const { body, signature } = signedEvent({
        id: "evt_identity_delete_old",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_old",
            customer: "cus_identity",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const row = await account();
      expect(row.stripeSubscriptionId).toBe("sub_new");
      expect(row.planId).toBe("pro");
      expect(row.creditQuota).toBe(80000);
      expect(row.subscriptionStatus).toBe("active");
    });

    it("still downgrades when the CURRENT subscription is the one deleted", async () => {
      // The guard refuses stale events, not real ones.
      await seedReplacedSubscription();

      const { body, signature } = signedEvent({
        id: "evt_identity_delete_current",
        type: "customer.subscription.deleted",
        data: {
          object: { id: "sub_new", customer: "cus_identity", metadata: { orgId, planId: "pro" } },
        },
      });

      await handleWebhook(body, signature);

      const row = await account();
      expect(row.stripeSubscriptionId).toBeNull();
      expect(row.planId).toBe("free");
      expect(row.creditQuota).toBe(0);
    });

    it("ignores an `updated` for the old subscription delivered after the new one attached", async () => {
      // Reversed order: `sub_old` was canceled first, but its update lands last.
      await seedReplacedSubscription();

      const { body, signature } = signedEvent({
        id: "evt_identity_update_old",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_old",
            status: "canceled",
            cancel_at_period_end: true,
            metadata: { orgId, planId: "starter" },
            items: {
              data: [{ id: "si_old", price: { id: "price_starter_test" } }],
            },
          },
        },
      });

      await handleWebhook(body, signature);

      const row = await account();
      expect(row.planId).toBe("pro");
      expect(row.subscriptionStatus).toBe("active");
      expect(row.cancelAtPeriodEnd).toBe(false);
    });

    it("ignores a late invoice.paid for the superseded subscription", async () => {
      // A renewal invoice for `sub_old` would re-attach the dead subscription AND reset
      // the live plan's quota and credit usage.
      await seedReplacedSubscription();
      setSubscriptionResponse({
        id: "sub_old",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: {
          object: "list",
          data: [{ id: "si_old", price: { id: "price_starter_test" } }],
        },
      });

      const { body, signature } = signedEvent({
        id: "evt_identity_invoice_old",
        type: "invoice.paid",
        data: {
          object: invoiceEventObject({
            id: "in_identity_old",
            customer: "cus_identity",
            subscription: "sub_old",
            billingReason: "subscription_cycle",
          }),
        },
      });

      await handleWebhook(body, signature);

      const row = await account();
      expect(row.stripeSubscriptionId).toBe("sub_new");
      expect(row.planId).toBe("pro");
      expect(row.creditQuota).toBe(80000);
      expect(row.creditsUsed).toBe(1000); // not reset by a foreign renewal
    });

    it("ignores a stale checkout completion for a different subscription", async () => {
      await seedReplacedSubscription();

      const { body, signature } = signedEvent({
        id: "evt_identity_checkout_old",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_identity",
            subscription: "sub_abandoned",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const row = await account();
      expect(row.stripeSubscriptionId).toBe("sub_new");
      expect(row.planId).toBe("pro");
      expect(row.creditQuota).toBe(80000);
    });

    /**
     * The identity guard pins on the subscription STRIPE holds, not on the id the row
     * carries: an account whose stored subscription is dead has nothing to supersede,
     * and dropping its next checkout would leave a paying customer with no plan.
     */
    describe("a dead subscription id does not block a new one", () => {
      async function seedDeadSubscription(status: string) {
        await seedBillingAccount({
          orgId,
          planId: "free",
          stripeCustomerId: "cus_identity",
          stripeSubscriptionId: "sub_dead",
          subscriptionStatus: status,
          creditQuota: 0,
        });
      }

      it("attaches a checkout completion over a `canceled` id", async () => {
        await seedDeadSubscription("canceled");

        const { body, signature } = signedEvent({
          id: "evt_dead_checkout_canceled",
          type: "checkout.session.completed",
          data: {
            object: {
              customer: "cus_identity",
              subscription: "sub_resubscribed",
              metadata: { orgId, planId: "starter" },
            },
          },
        });

        await handleWebhook(body, signature);

        const row = await account();
        expect(row.stripeSubscriptionId).toBe("sub_resubscribed");
        expect(row.planId).toBe("starter");
        expect(row.creditQuota).toBe(20000);
      });

      it("attaches a checkout completion over an `incomplete_expired` id", async () => {
        await seedDeadSubscription("incomplete_expired");

        const { body, signature } = signedEvent({
          id: "evt_dead_checkout_expired",
          type: "checkout.session.completed",
          data: {
            object: {
              customer: "cus_identity",
              subscription: "sub_after_expiry",
              metadata: { orgId, planId: "pro" },
            },
          },
        });

        await handleWebhook(body, signature);

        const row = await account();
        expect(row.stripeSubscriptionId).toBe("sub_after_expiry");
        expect(row.planId).toBe("pro");
        expect(row.creditQuota).toBe(80000);
      });

      it("attaches a `created` over a `canceled` id", async () => {
        await seedDeadSubscription("canceled");

        const { body, signature } = signedCreatedEvent("evt_dead_created", {
          id: "sub_recreated",
          customer: "cus_identity",
          status: "active",
          cancel_at_period_end: false,
          metadata: { orgId, planId: "starter" },
          items: { data: [{ id: "si_recreated", price: { id: "price_starter_test" } }] },
        });

        await handleWebhook(body, signature);

        const row = await account();
        expect(row.stripeSubscriptionId).toBe("sub_recreated");
        expect(row.planId).toBe("starter");
      });

      it("still ignores a checkout completion for an account on a HELD subscription", async () => {
        // Control: `unpaid` is held, so the account is not free to be re-attached.
        await seedDeadSubscription("unpaid");

        const { body, signature } = signedEvent({
          id: "evt_held_checkout",
          type: "checkout.session.completed",
          data: {
            object: {
              customer: "cus_identity",
              subscription: "sub_second_attempt",
              metadata: { orgId, planId: "starter" },
            },
          },
        });

        await handleWebhook(body, signature);

        const row = await account();
        expect(row.stripeSubscriptionId).toBe("sub_dead");
        expect(row.planId).toBe("free");
      });
    });

    it("ignores a `created` for a second subscription on an already-linked account", async () => {
      await seedReplacedSubscription();

      const { body, signature } = signedCreatedEvent("evt_identity_created_second", {
        id: "sub_second",
        customer: "cus_identity",
        status: "active",
        cancel_at_period_end: false,
        metadata: { orgId, planId: "starter" },
        items: { data: [{ id: "si_second", price: { id: "price_starter_test" } }] },
      });

      await handleWebhook(body, signature);

      expect((await account()).stripeSubscriptionId).toBe("sub_new");
    });
  });

  describe("idempotency", () => {
    it("skips duplicate events (same eventId already processed)", async () => {
      await seedBillingAccount({ orgId });

      // First call — processes the event
      const { body, signature } = signedEvent({
        id: "evt_idempotent_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_idemp_001",
            subscription: "sub_idemp_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      // Verify it was processed
      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));
      expect(account!.planId).toBe("starter");

      // Reset to free to check if second call re-processes
      await db
        .update(billingAccounts)
        .set({ planId: "free" })
        .where(eq(billingAccounts.orgId, orgId));

      // Second call with same event — should be skipped (idempotent)
      const { body: body2, signature: sig2 } = signedEvent({
        id: "evt_idempotent_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_idemp_001",
            subscription: "sub_idemp_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body2, sig2);

      // Should still be "free" because the duplicate was skipped
      const [accountAfter] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));
      expect(accountAfter!.planId).toBe("free");
    });

    it("deletes stale claims (>5min) for retry", async () => {
      const db = getEeDb();

      // Manually insert a stale stripe_event claim (6 minutes old)
      const staleTime = new Date(Date.now() - 6 * 60 * 1000);
      await db.insert(stripeEvents).values({
        eventId: "evt_stale_001",
        eventType: "checkout.session.completed",
        status: "processing",
        claimedAt: staleTime,
      });

      await seedBillingAccount({ orgId });

      const { body, signature } = signedEvent({
        id: "evt_stale_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_stale_001",
            subscription: "sub_stale_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      // Should throw (reclaimed stale event — will process on next Stripe retry)
      try {
        await handleWebhook(body, signature);
        expect.unreachable("should have thrown for stale claim");
      } catch (err) {
        expect((err as Error).message).toContain("Reclaimed stale event");
      }

      // The stale claim should be deleted, allowing the next retry to process it
      const [event] = await db
        .select()
        .from(stripeEvents)
        .where(eq(stripeEvents.eventId, "evt_stale_001"));
      expect(event).toBeUndefined();
    });
  });

  describe("signature verification", () => {
    it("rejects events with invalid signature", async () => {
      const { body } = signedEvent({
        id: "evt_invalid_sig_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_sig_001",
            subscription: "sub_sig_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await expect(
        handleWebhook(body, "t=1234567890,v1=invalid_signature_value"),
      ).rejects.toThrow();
    });
  });

  describe("events with invalid metadata", () => {
    it("skips checkout.session.completed with invalid metadata gracefully", async () => {
      await seedBillingAccount({ orgId });

      const { body, signature } = signedEvent({
        id: "evt_bad_meta_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_bad_001",
            subscription: "sub_bad_001",
            metadata: { invalid: "no orgId" },
          },
        },
      });

      // Should not throw — just logs and skips
      await handleWebhook(body, signature);

      // Account should remain unchanged
      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));
      expect(account!.planId).toBe("free");
    });
  });

  describe("event claim lifecycle", () => {
    it("marks event as done after successful processing", async () => {
      await seedBillingAccount({ orgId });

      const { body, signature } = signedEvent({
        id: "evt_lifecycle_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_life_001",
            subscription: "sub_life_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      const db = getEeDb();
      const [event] = await db
        .select()
        .from(stripeEvents)
        .where(eq(stripeEvents.eventId, "evt_lifecycle_001"));

      expect(event).toBeDefined();
      expect(event!.status).toBe("done");
      expect(event!.processedAt).toBeDefined();
    });
  });
});
