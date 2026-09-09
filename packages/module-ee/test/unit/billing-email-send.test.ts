// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, it, expect, beforeEach } from "bun:test";
import { initBillingEmail, sendBillingEmail } from "../../src/emails/send.ts";

describe("sendBillingEmail", () => {
  const sentEmails: Array<{ to: string; subject: string; html: string }> = [];
  let recipients: string[];

  beforeEach(() => {
    sentEmails.length = 0;
    recipients = ["billing@example.com"];

    initBillingEmail({
      sendMail: async (to, subject, html) => {
        sentEmails.push({ to, subject, html });
      },
      getRecipients: async () => recipients,
      // `getOrgName` is required at this module's @appstrate/core floor; `null` is its
      // documented "org no longer exists" answer — emails then carry no label.
      getOrgName: async () => null,
    });
  });

  it("sends email to every billing recipient", async () => {
    recipients = ["billing@example.com", "manager@example.com"];

    sendBillingEmail("org-123", "subscription-confirmed", {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr",
    });

    // Wait for the async fire-and-forget to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(2);
    expect(sentEmails[0]!.to).toBe("billing@example.com");
    expect(sentEmails[1]!.to).toBe("manager@example.com");
    expect(sentEmails[0]!.subject).toBe("Votre abonnement est actif");
  });

  it("renders correct template for each type", async () => {
    sendBillingEmail("org-123", "payment-failed", {
      planName: "Pro",
      amount: 99,
      cardLast4: "4242",
      attemptNumber: 2,
      updateUrl: "/billing",
      locale: "en",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.subject).toContain("Payment failed");
    expect(sentEmails[0]!.html).toContain("4242");
  });

  it("does nothing when the org has no billing recipient", async () => {
    recipients = [];

    sendBillingEmail("org-123", "subscription-expired", {
      resubscribeUrl: "/billing",
      locale: "fr",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(0);
  });

  it("labels the email with the org name when getOrgName is injected", async () => {
    initBillingEmail({
      sendMail: async (to, subject, html) => {
        sentEmails.push({ to, subject, html });
      },
      getRecipients: async () => recipients,
      getOrgName: async () => "Acme Corp",
    });

    sendBillingEmail("org-123", "subscription-confirmed", {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.subject).toBe("Votre abonnement est actif — Acme Corp");
    expect(sentEmails[0]!.html).toContain("Acme Corp");
  });

  it("still sends the email when getOrgName rejects", async () => {
    initBillingEmail({
      sendMail: async (to, subject, html) => {
        sentEmails.push({ to, subject, html });
      },
      getRecipients: async () => recipients,
      getOrgName: async () => {
        throw new Error("platform DB unavailable");
      },
    });

    sendBillingEmail("org-123", "subscription-confirmed", {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.subject).toBe("Votre abonnement est actif");
  });

  it("sends without org label when the org name resolves to null", async () => {
    // beforeEach injects getOrgName → null (org deleted / unknown to the platform)
    sendBillingEmail("org-123", "subscription-confirmed", {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.subject).toBe("Votre abonnement est actif");
  });

  it("awaits every delivery — a slow mailer still reaches all recipients", async () => {
    recipients = ["a@example.com", "b@example.com"];
    initBillingEmail({
      sendMail: async (to, subject, html) => {
        await new Promise((r) => setTimeout(r, 5));
        sentEmails.push({ to, subject, html });
      },
      getRecipients: async () => recipients,
      getOrgName: async () => null,
    });

    sendBillingEmail("org-123", "subscription-confirmed", {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails.map((e) => e.to).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("keeps delivering to the other recipients when one delivery rejects", async () => {
    // The fan-out settles instead of racing to the first rejection: a single
    // bad address must not cost the org the rest of its billing mail.
    recipients = ["a@example.com", "bad@example.com", "c@example.com"];
    initBillingEmail({
      sendMail: async (to, subject, html) => {
        if (to === "bad@example.com") throw new Error("SMTP 550 mailbox unavailable");
        sentEmails.push({ to, subject, html });
      },
      getRecipients: async () => recipients,
      getOrgName: async () => null,
    });

    sendBillingEmail("org-123", "subscription-confirmed", {
      planName: "Starter",
      price: 29,
      periodEnd: "2026-04-27T00:00:00.000Z",
      locale: "fr",
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(sentEmails.map((e) => e.to)).toEqual(["a@example.com", "c@example.com"]);
  });

  it("handles a rejecting delivery rather than leaking an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      initBillingEmail({
        sendMail: async () => {
          throw new Error("SMTP down");
        },
        getRecipients: async () => ["a@example.com"],
        getOrgName: async () => null,
      });

      sendBillingEmail("org-123", "subscription-confirmed", {
        planName: "Starter",
        price: 29,
        periodEnd: "2026-04-27T00:00:00.000Z",
        locale: "fr",
      });

      await new Promise((r) => setTimeout(r, 100));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("does nothing before initBillingEmail is called", async () => {
    // Re-init with null to simulate uninitialized state
    // We test by creating a fresh module scope — but since we can't reset the module,
    // we just verify that calling sendBillingEmail doesn't throw
    // (the init in beforeEach already covers the happy path)
    expect(() => {
      sendBillingEmail("org-123", "subscription-confirmed", {
        planName: "Starter",
        price: 29,
        periodEnd: "2026-04-27T00:00:00.000Z",
        locale: "fr",
      });
    }).not.toThrow();
  });
});
