import { describe, it, expect } from "bun:test";
import { renderSubscriptionConfirmedEmail } from "../../src/emails/templates/subscription-confirmed.ts";
import { renderPaymentReceiptEmail } from "../../src/emails/templates/payment-receipt.ts";
import { renderPaymentFailedEmail } from "../../src/emails/templates/payment-failed.ts";
import { renderCancellationConfirmedEmail } from "../../src/emails/templates/cancellation-confirmed.ts";
import { renderSubscriptionExpiredEmail } from "../../src/emails/templates/subscription-expired.ts";
import { renderPlanChangedEmail } from "../../src/emails/templates/plan-changed.ts";
import { renderQuotaWarningEmail } from "../../src/emails/templates/quota-warning.ts";
import { renderRenewalReminderEmail } from "../../src/emails/templates/renewal-reminder.ts";
import { renderCardExpiringEmail } from "../../src/emails/templates/card-expiring.ts";
import { renderBillingEmail } from "../../src/emails/registry.ts";

describe("billing email templates", () => {
  // -----------------------------------------------------------------------
  // subscription-confirmed
  // -----------------------------------------------------------------------
  describe("subscription-confirmed", () => {
    const baseProps = {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr" as const,
    };

    it("renders French subject and content", () => {
      const result = renderSubscriptionConfirmedEmail(baseProps);
      expect(result.subject).toBe("Votre abonnement est actif");
      expect(result.html).toContain("Starter");
      expect(result.html).toContain("29");
    });

    it("renders English version", () => {
      const result = renderSubscriptionConfirmedEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toBe("Your subscription is active");
      expect(result.html).toContain("Starter");
    });

    it("wraps in cloud layout", () => {
      const result = renderSubscriptionConfirmedEmail(baseProps);
      expect(result.html).toContain("<!DOCTYPE html");
      expect(result.html).toContain("appstrate.com");
    });
  });

  // -----------------------------------------------------------------------
  // payment-receipt
  // -----------------------------------------------------------------------
  describe("payment-receipt", () => {
    const baseProps = {
      planName: "Pro",
      amount: 99,
      invoiceUrl: "https://invoice.stripe.com/i/abc",
      periodEnd: "2026-05-01T00:00:00.000Z",
      locale: "fr" as const,
    };

    it("renders French receipt with invoice link", () => {
      const result = renderPaymentReceiptEmail(baseProps);
      expect(result.subject).toContain("99.00");
      expect(result.html).toContain("Pro");
      expect(result.html).toContain("https://invoice.stripe.com/i/abc");
    });

    it("renders without invoice link", () => {
      const result = renderPaymentReceiptEmail({ ...baseProps, invoiceUrl: null });
      expect(result.html).not.toContain("Voir la facture");
      expect(result.html).toContain("portail de facturation");
    });

    it("renders English version", () => {
      const result = renderPaymentReceiptEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toContain("Payment receipt");
    });
  });

  // -----------------------------------------------------------------------
  // payment-failed (dunning escalation)
  // -----------------------------------------------------------------------
  describe("payment-failed", () => {
    const baseProps = {
      planName: "Starter",
      amount: 29,
      cardLast4: "4242",
      attemptNumber: 1,
      updateUrl: "/settings/billing",
      locale: "fr" as const,
    };

    it("renders first attempt with friendly tone", () => {
      const result = renderPaymentFailedEmail(baseProps);
      expect(result.html).toContain("pas abouti");
      expect(result.html).toContain("4242");
    });

    it("renders second attempt with more urgency", () => {
      const result = renderPaymentFailedEmail({ ...baseProps, attemptNumber: 2 });
      expect(result.html).toContain("Deuxieme tentative");
    });

    it("renders third+ attempt as final warning", () => {
      const result = renderPaymentFailedEmail({ ...baseProps, attemptNumber: 3 });
      expect(result.html).toContain("Derniere tentative");
    });

    it("clamps attempt number above 3 to final warning", () => {
      const result = renderPaymentFailedEmail({ ...baseProps, attemptNumber: 5 });
      expect(result.html).toContain("Derniere tentative");
    });

    it("handles null cardLast4", () => {
      const result = renderPaymentFailedEmail({ ...baseProps, cardLast4: null });
      expect(result.html).not.toContain("Carte concern");
    });

    it("renders English version", () => {
      const result = renderPaymentFailedEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toContain("Payment failed");
      expect(result.html).toContain("didn't go through");
    });
  });

  // -----------------------------------------------------------------------
  // cancellation-confirmed
  // -----------------------------------------------------------------------
  describe("cancellation-confirmed", () => {
    const baseProps = {
      planName: "Pro",
      accessUntil: "2026-04-30T00:00:00.000Z",
      locale: "fr" as const,
    };

    it("renders French cancellation", () => {
      const result = renderCancellationConfirmedEmail(baseProps);
      expect(result.subject).toContain("annulation");
      expect(result.html).toContain("Pro");
      expect(result.html).toContain("plan Free");
    });

    it("renders English version", () => {
      const result = renderCancellationConfirmedEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toBe("Subscription cancellation confirmed");
      expect(result.html).toContain("Free plan");
    });
  });

  // -----------------------------------------------------------------------
  // subscription-expired
  // -----------------------------------------------------------------------
  describe("subscription-expired", () => {
    it("renders French expiration with resubscribe CTA", () => {
      const result = renderSubscriptionExpiredEmail({
        resubscribeUrl: "/settings/billing",
        locale: "fr",
      });
      expect(result.subject).toContain("expire");
      expect(result.html).toContain("/settings/billing");
      expect(result.html).toContain("reabonner");
    });

    it("renders English version", () => {
      const result = renderSubscriptionExpiredEmail({
        resubscribeUrl: "/settings/billing",
        locale: "en",
      });
      expect(result.subject).toContain("expired");
      expect(result.html).toContain("Resubscribe");
    });
  });

  // -----------------------------------------------------------------------
  // plan-changed
  // -----------------------------------------------------------------------
  describe("plan-changed", () => {
    const baseProps = {
      oldPlanName: "Starter",
      newPlanName: "Pro",
      newPrice: 99,
      effectiveDate: "2026-04-01T00:00:00.000Z",
      locale: "fr" as const,
    };

    it("renders French plan change", () => {
      const result = renderPlanChangedEmail(baseProps);
      expect(result.subject).toContain("modifie");
      expect(result.html).toContain("Starter");
      expect(result.html).toContain("Pro");
      expect(result.html).toContain("99");
    });

    it("renders English version", () => {
      const result = renderPlanChangedEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toBe("Your plan has been changed");
    });
  });

  // -----------------------------------------------------------------------
  // quota-warning
  // -----------------------------------------------------------------------
  describe("quota-warning", () => {
    const baseProps = {
      planName: "Starter",
      usagePercent: 85,
      creditsUsed: 17000,
      creditQuota: 20000,
      upgradeUrl: "/settings/billing",
      locale: "fr" as const,
    };

    it("renders French quota warning with percentage", () => {
      const result = renderQuotaWarningEmail(baseProps);
      expect(result.subject).toContain("85");
      expect(result.html).toContain("Starter");
      expect(result.html).toContain("80");
    });

    it("renders English version", () => {
      const result = renderQuotaWarningEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toContain("85%");
      expect(result.html).toContain("Upgrade my plan");
    });
  });

  // -----------------------------------------------------------------------
  // renewal-reminder
  // -----------------------------------------------------------------------
  describe("renewal-reminder", () => {
    const baseProps = {
      planName: "Pro",
      amount: 99,
      renewalDate: "2026-04-27T00:00:00.000Z",
      portalUrl: "/settings/billing",
      locale: "fr" as const,
    };

    it("renders French renewal reminder", () => {
      const result = renderRenewalReminderEmail(baseProps);
      expect(result.subject).toContain("renouvele");
      expect(result.html).toContain("Pro");
      expect(result.html).toContain("99");
    });

    it("renders English version", () => {
      const result = renderRenewalReminderEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toContain("renews on");
    });
  });

  // -----------------------------------------------------------------------
  // card-expiring
  // -----------------------------------------------------------------------
  describe("card-expiring", () => {
    const baseProps = {
      cardLast4: "4242",
      expiryMonth: "03/27",
      updateUrl: "/settings/billing",
      locale: "fr" as const,
    };

    it("renders French card expiring warning", () => {
      const result = renderCardExpiringEmail(baseProps);
      expect(result.subject).toContain("expire");
      expect(result.html).toContain("4242");
      expect(result.html).toContain("03/27");
    });

    it("renders English version", () => {
      const result = renderCardExpiringEmail({ ...baseProps, locale: "en" });
      expect(result.subject).toBe("Your payment card is expiring soon");
    });

    it("escapes HTML in card values", () => {
      const result = renderCardExpiringEmail({
        ...baseProps,
        cardLast4: "<script>",
      });
      expect(result.html).not.toContain("<script>");
      expect(result.html).toContain("&lt;script&gt;");
    });
  });

  // -----------------------------------------------------------------------
  // registry
  // -----------------------------------------------------------------------
  describe("renderBillingEmail registry", () => {
    it("routes to correct renderer by type", () => {
      const result = renderBillingEmail("subscription-confirmed", {
        planName: "Starter",
        price: 29,
        periodEnd: "2026-04-27T00:00:00.000Z",
        locale: "fr",
      });
      expect(result.subject).toBe("Votre abonnement est actif");
    });

    it("routes payment-failed to correct renderer", () => {
      const result = renderBillingEmail("payment-failed", {
        planName: "Pro",
        amount: 99,
        cardLast4: null,
        attemptNumber: 1,
        updateUrl: "/billing",
        locale: "en",
      });
      expect(result.subject).toContain("Payment failed");
    });
  });

  // -----------------------------------------------------------------------
  // org-name context (subject suffix + layout header line)
  // -----------------------------------------------------------------------
  describe("org-name context", () => {
    const baseProps = {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr" as const,
    };

    it("suffixes the subject and renders the org line in French", () => {
      const result = renderBillingEmail("subscription-confirmed", baseProps, {
        orgName: "Acme Corp",
      });
      expect(result.subject).toBe("Votre abonnement est actif — Acme Corp");
      expect(result.html).toContain("Organisation\u00a0:");
      expect(result.html).toContain("Acme Corp");
    });

    it("renders the English org label", () => {
      const result = renderBillingEmail(
        "subscription-confirmed",
        { ...baseProps, locale: "en" },
        { orgName: "Acme Corp" },
      );
      expect(result.subject).toBe("Your subscription is active — Acme Corp");
      expect(result.html).toContain("Organization:");
    });

    it("applies the context to every billing email type", () => {
      const context = { orgName: "Acme Corp" };
      const rendered = [
        renderBillingEmail("subscription-confirmed", baseProps, context),
        renderBillingEmail(
          "payment-receipt",
          {
            planName: "Pro",
            amount: 99,
            invoiceUrl: null,
            periodEnd: "2026-05-01T00:00:00.000Z",
            locale: "fr",
          },
          context,
        ),
        renderBillingEmail(
          "payment-failed",
          {
            planName: "Pro",
            amount: 99,
            cardLast4: null,
            attemptNumber: 1,
            updateUrl: "/billing",
            locale: "fr",
          },
          context,
        ),
        renderBillingEmail(
          "cancellation-confirmed",
          { planName: "Pro", accessUntil: "2026-04-30T00:00:00.000Z", locale: "fr" },
          context,
        ),
        renderBillingEmail(
          "subscription-expired",
          { resubscribeUrl: "/billing", locale: "fr" },
          context,
        ),
        renderBillingEmail(
          "plan-changed",
          {
            oldPlanName: "Starter",
            newPlanName: "Pro",
            newPrice: 99,
            effectiveDate: "2026-04-01T00:00:00.000Z",
            locale: "fr",
          },
          context,
        ),
        renderBillingEmail(
          "quota-warning",
          {
            planName: "Starter",
            usagePercent: 85,
            creditsUsed: 17000,
            creditQuota: 20000,
            upgradeUrl: "/billing",
            locale: "fr",
          },
          context,
        ),
        renderBillingEmail(
          "renewal-reminder",
          {
            planName: "Pro",
            amount: 99,
            renewalDate: "2026-04-27T00:00:00.000Z",
            portalUrl: "/billing",
            locale: "fr",
          },
          context,
        ),
        renderBillingEmail(
          "card-expiring",
          { cardLast4: "4242", expiryMonth: "03/27", updateUrl: "/billing", locale: "fr" },
          context,
        ),
      ];

      for (const result of rendered) {
        expect(result.subject).toEndWith(" — Acme Corp");
        expect(result.html).toContain("Acme Corp");
      }
    });

    it("renders without suffix or org line when context is absent", () => {
      const result = renderBillingEmail("subscription-confirmed", baseProps);
      expect(result.subject).toBe("Votre abonnement est actif");
      expect(result.html).not.toContain("Organisation\u00a0:");
    });

    it("renders without suffix when orgName is null or blank", () => {
      const withNull = renderBillingEmail("subscription-confirmed", baseProps, { orgName: null });
      expect(withNull.subject).toBe("Votre abonnement est actif");

      const withBlank = renderBillingEmail("subscription-confirmed", baseProps, {
        orgName: "   ",
      });
      expect(withBlank.subject).toBe("Votre abonnement est actif");
      expect(withBlank.html).not.toContain("Organisation\u00a0:");
    });

    it("escapes HTML in the org name (user-controlled input)", () => {
      const result = renderBillingEmail("subscription-confirmed", baseProps, {
        orgName: '<img src=x onerror=alert(1)> & "Co"',
      });
      expect(result.html).not.toContain("<img src=x");
      expect(result.html).toContain("&lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;");
    });

    it("strips newlines from the subject suffix (header-injection guard)", () => {
      const result = renderBillingEmail("subscription-confirmed", baseProps, {
        orgName: "Acme\r\nBcc: evil@example.com",
      });
      expect(result.subject).not.toMatch(/[\r\n]/);
    });
  });
});
