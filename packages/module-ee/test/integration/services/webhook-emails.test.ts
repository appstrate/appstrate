// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import {
  resetStripeMock,
  generateWebhookEvent,
  setSubscriptionResponse,
} from "../../helpers/stripe.ts";
import { handleWebhook } from "../../../src/stripe/webhooks.ts";
import { initBillingEmail } from "../../../src/emails/send.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

const WEBHOOK_SECRET = "whsec_test_secret_for_webhook_verification";

/**
 * Integration tests verifying that webhook handlers trigger the correct
 * billing emails. Uses DI via initBillingEmail() — no mock.module(). WHO the
 * recipients are is `emails/recipients.ts`'s job and is asserted there; this
 * file only checks that each webhook renders and fans out the right template.
 */
describe("webhook billing emails", () => {
  const orgId = "00000000-0000-4000-a000-000000000050";
  const sentEmails: Array<{ to: string; subject: string }> = [];

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
    sentEmails.length = 0;

    initBillingEmail({
      sendMail: (to, subject) => {
        sentEmails.push({ to, subject });
      },
      getRecipients: async () => ["billing@test.com"],
      getOrgName: async () => null,
    });
  });

  function signedEvent(payload: object) {
    return generateWebhookEvent(payload, WEBHOOK_SECRET);
  }

  describe("checkout.session.completed", () => {
    it("sends subscription-confirmed email", async () => {
      await seedBillingAccount({ orgId });

      const { body, signature } = signedEvent({
        id: "evt_email_checkout_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_email_001",
            subscription: "sub_email_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);

      // Wait for fire-and-forget async
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]!.subject).toBe("Votre abonnement est actif");
      expect(sentEmails[0]!.to).toBe("billing@test.com");
    });
  });

  describe("invoice.paid", () => {
    it("sends payment-receipt email", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_email_inv_001",
        stripeSubscriptionId: "sub_email_inv_001",
        subscriptionStatus: "active",
        creditsUsed: 0,
        creditQuota: 20000,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
      setSubscriptionResponse({
        id: "sub_email_inv_001",
        object: "subscription",
        status: "active",
        metadata: { orgId, planId: "starter" },
        items: {
          object: "list",
          data: [
            {
              id: "si_email_001",
              current_period_end: periodEnd,
              price: { id: "price_starter_test" },
            },
          ],
        },
      });

      const { body, signature } = signedEvent({
        id: "evt_email_invoice_001",
        type: "invoice.paid",
        data: {
          object: {
            id: "in_email_001",
            customer: "cus_email_inv_001",
            billing_reason: "subscription_cycle",
            amount_paid: 2900,
            hosted_invoice_url: "https://invoice.stripe.com/i/test",
            parent: {
              subscription_details: {
                subscription: "sub_email_inv_001",
              },
            },
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]!.subject).toContain("29.00");
    });
  });

  describe("customer.subscription.updated (cancellation)", () => {
    it("sends cancellation-confirmed when cancel_at_period_end turns true", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_email_cancel_001",
        stripeSubscriptionId: "sub_email_cancel_001",
        subscriptionStatus: "active",
        cancelAtPeriodEnd: false,
      });

      const periodEnd = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;

      const { body, signature } = signedEvent({
        id: "evt_email_cancel_001",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_email_cancel_001",
            status: "active",
            cancel_at_period_end: true,
            metadata: { orgId, planId: "starter" },
            items: {
              data: [
                {
                  id: "si_email_cancel_001",
                  price: { id: "price_starter_test" },
                  current_period_end: periodEnd,
                },
              ],
            },
          },
          previous_attributes: {
            cancel_at_period_end: false,
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]!.subject).toContain("annulation");
    });
  });

  describe("customer.subscription.deleted", () => {
    it("sends subscription-expired email", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_email_del_001",
        stripeSubscriptionId: "sub_email_del_001",
        subscriptionStatus: "active",
      });

      const { body, signature } = signedEvent({
        id: "evt_email_del_001",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_email_del_001",
            customer: "cus_email_del_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]!.subject).toContain("expire");
    });
  });

  describe("invoice.payment_failed", () => {
    it("sends payment-failed email", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_email_fail_001",
        stripeSubscriptionId: "sub_email_fail_001",
        subscriptionStatus: "active",
      });

      const { body, signature } = signedEvent({
        id: "evt_email_fail_001",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_email_fail_001",
            customer: "cus_email_fail_001",
            billing_reason: "subscription_cycle",
            amount_due: 2900,
            attempt_count: 2,
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(1);
      expect(sentEmails[0]!.subject).toContain("Echec de paiement");
    });
  });

  describe("invoice.payment_failed for a superseded subscription", () => {
    it("sends no dunning notice about a subscription the org has replaced", async () => {
      // Telling a customer their plan is failing to charge, when the failing
      // subscription is one they already left, is a false alarm.
      await seedBillingAccount({
        orgId,
        planId: "pro",
        stripeCustomerId: "cus_email_fail_002",
        stripeSubscriptionId: "sub_email_new",
        subscriptionStatus: "active",
      });

      const { body, signature } = signedEvent({
        id: "evt_email_fail_002",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_email_fail_002",
            customer: "cus_email_fail_002",
            billing_reason: "subscription_cycle",
            amount_due: 2900,
            attempt_count: 2,
            parent: { subscription_details: { subscription: "sub_email_old" } },
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(0);
    });
  });

  describe("no email on events without account", () => {
    it("does not send email when invoice.paid has unknown customer", async () => {
      const { body, signature } = signedEvent({
        id: "evt_email_unknown_001",
        type: "invoice.payment_failed",
        data: {
          object: {
            id: "in_unknown_001",
            customer: "cus_nonexistent",
            billing_reason: "subscription_cycle",
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(0);
    });
  });

  describe("sends to every billing recipient", () => {
    it("sends one email per recipient", async () => {
      initBillingEmail({
        sendMail: (to, subject) => {
          sentEmails.push({ to, subject });
        },
        getRecipients: async () => ["billing@test.com", "cfo@test.com"],
        getOrgName: async () => null,
      });

      await seedBillingAccount({ orgId });

      const { body, signature } = signedEvent({
        id: "evt_email_multi_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_multi_001",
            subscription: "sub_multi_001",
            metadata: { orgId, planId: "pro" },
          },
        },
      });

      await handleWebhook(body, signature);
      await new Promise((r) => setTimeout(r, 100));

      expect(sentEmails).toHaveLength(2);
      expect(sentEmails.map((e) => e.to).sort()).toEqual(["billing@test.com", "cfo@test.com"]);
    });
  });
});
