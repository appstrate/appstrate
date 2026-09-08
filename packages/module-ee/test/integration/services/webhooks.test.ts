// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateEeTables, getEeDb } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import {
  resetStripeMock,
  generateWebhookEvent,
  setSubscriptionResponse,
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
  });

  describe("customer.subscription.created", () => {
    it("stores subscription if account has no subscriptionId yet", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_sub_created_001",
        stripeSubscriptionId: null,
      });

      const { body, signature } = signedEvent({
        id: "evt_sub_created_001",
        type: "customer.subscription.created",
        data: {
          object: {
            id: "sub_created_001",
            customer: "cus_sub_created_001",
            status: "active",
            cancel_at_period_end: false,
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
      const { body, signature } = signedEvent({
        id: "evt_sub_trial_001",
        type: "customer.subscription.created",
        data: {
          object: {
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
          object: {
            id: "in_cycle_001",
            customer: "cus_invoice_001",
            billing_reason: "subscription_cycle",
            parent: {
              subscription_details: {
                subscription: "sub_invoice_001",
              },
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
          object: {
            id: "in_create_001",
            customer: "cus_invoice_002",
            billing_reason: "subscription_create",
            parent: {
              subscription_details: {
                subscription: "sub_invoice_002",
              },
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

      expect(account!.creditsUsed).toBe(500);
      expect(account!.creditQuota).toBe(20000);
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
          object: {
            id: "in_race_001",
            customer: "cus_race_001",
            billing_reason: "subscription_create",
            parent: { subscription_details: { subscription: "sub_race_001" } },
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
          object: {
            id: "in_portal_001",
            customer: "cus_portal_001",
            billing_reason: "subscription_update",
            parent: { subscription_details: { subscription: "sub_portal_001" } },
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
          object: {
            id: "in_fail_001",
            customer: "cus_fail_001",
            billing_reason: "subscription_cycle",
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
      expect(account!.creditsUsed).toBe(1000);
      expect(account!.creditQuota).toBe(20000);
      expect(account!.subscriptionStatus).toBe("active");
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
