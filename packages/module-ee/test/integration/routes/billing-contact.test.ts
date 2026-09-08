// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount, seedBillingManager } from "../../helpers/seed.ts";
import { seedOrgMembers } from "../../helpers/org-queries.ts";
import { getTestApp } from "../../helpers/app.ts";
import { resetStripeMock, requests } from "../../helpers/stripe.ts";
import { resolveBillingRecipients } from "../../../src/emails/recipients.ts";
import { createCheckoutSession } from "../../../src/stripe/checkout.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

/**
 * Billing contact (RBAC spec §10): the address invoices go to, the CC list, and
 * the two things that read them — the billing-email recipients and the Stripe
 * customer.
 */
describe("billing contact", () => {
  const orgId = "00000000-0000-4000-a000-0000000000c0";
  const app = getTestApp();

  function headers(overrides?: Record<string, string>) {
    return {
      "X-Test-Org-Id": orgId,
      "X-Test-Org-Role": "owner",
      "X-Test-User-Id": "user-owner",
      "content-type": "application/json",
      ...overrides,
    };
  }

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
    seedOrgMembers(orgId, [
      { userId: "user-owner", email: "owner@example.com", role: "owner" },
      { userId: "user-admin", email: "admin@example.com", role: "admin" },
      { userId: "user-finance", email: "finance@example.com", role: "member" },
    ]);
  });

  describe("GET /api/billing/contact", () => {
    it("returns the stored contact", async () => {
      await seedBillingAccount({
        orgId,
        billingEmail: "billing@example.com",
        billingCc: ["cfo@example.com"],
      });

      const res = await app.request("/api/billing/contact", { headers: headers() });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        billing_email: "billing@example.com",
        billing_cc: ["cfo@example.com"],
      });
    });

    it("404s when the org has no billing account", async () => {
      const res = await app.request("/api/billing/contact", { headers: headers() });
      expect(res.status).toBe(404);
    });

    it("refuses a plain member", async () => {
      await seedBillingAccount({ orgId });
      const res = await app.request("/api/billing/contact", {
        headers: headers({ "X-Test-Org-Role": "member", "X-Test-User-Id": "user-finance" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("PATCH /api/billing/contact", () => {
    beforeEach(async () => {
      await seedBillingAccount({ orgId, stripeCustomerId: "cus_test_contact" });
    });

    it("sets the address and the CC list", async () => {
      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({
          billing_email: "billing@example.com",
          billing_cc: ["cfo@example.com", "accounting@example.com"],
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        billing_email: "billing@example.com",
        billing_cc: ["cfo@example.com", "accounting@example.com"],
      });
    });

    it("leaves an omitted field alone", async () => {
      await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_cc: ["cfo@example.com"] }),
      });
      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_email: "billing@example.com" }),
      });
      expect(await res.json()).toEqual({
        billing_email: "billing@example.com",
        billing_cc: ["cfo@example.com"],
      });
    });

    it("clears the contact on an explicit null, falling back to the owners", async () => {
      await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_email: "billing@example.com" }),
      });

      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_email: null }),
      });
      expect(((await res.json()) as { billing_email: string | null }).billing_email).toBeNull();
      expect(await resolveBillingRecipients(orgId)).toEqual(["owner@example.com"]);
    });

    it("pushes the new address to the Stripe customer", async () => {
      await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_email: "billing@example.com" }),
      });

      const update = requests.find(
        (r) => r.method === "POST" && r.path === "/v1/customers/cus_test_contact",
      );
      expect(update?.body?.email).toBe("billing@example.com");
    });

    it("does not touch Stripe when only the CC list moves", async () => {
      await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_cc: ["cfo@example.com"] }),
      });
      expect(requests.filter((r) => r.path.startsWith("/v1/customers"))).toHaveLength(0);
    });

    it("rejects an address that is not an email", async () => {
      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_email: "not-an-email" }),
      });
      expect(res.status).toBe(400);
    });

    it("rejects a CC entry that is not an email", async () => {
      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_cc: ["cfo@example.com", "nope"] }),
      });
      expect(res.status).toBe(400);
    });

    it("accepts 5 CC addresses and rejects 6", async () => {
      const five = ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"];
      const ok = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_cc: five }),
      });
      expect(ok.status).toBe(200);

      const tooMany = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ billing_cc: [...five, "f@x.com"] }),
      });
      expect(tooMany.status).toBe(400);
    });

    it("rejects a malformed body", async () => {
      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers(),
        body: "not json",
      });
      expect(res.status).toBe(400);
    });

    it("refuses a plain member", async () => {
      const res = await app.request("/api/billing/contact", {
        method: "PATCH",
        headers: headers({ "X-Test-Org-Role": "member", "X-Test-User-Id": "user-finance" }),
        body: JSON.stringify({ billing_email: "billing@example.com" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("resolveBillingRecipients", () => {
    it("unions the contact, the CC list and the managers", async () => {
      await seedBillingAccount({
        orgId,
        billingEmail: "billing@example.com",
        billingCc: ["cfo@example.com"],
      });
      await seedBillingManager({ orgId, userId: "user-finance" });

      expect(await resolveBillingRecipients(orgId)).toEqual([
        "billing@example.com",
        "cfo@example.com",
        "finance@example.com",
      ]);
    });

    it("falls back to the owners when no contact is set", async () => {
      await seedBillingAccount({ orgId });
      expect(await resolveBillingRecipients(orgId)).toEqual(["owner@example.com"]);
    });

    it("is empty for an org with no billing account", async () => {
      expect(await resolveBillingRecipients(orgId)).toEqual([]);
    });
  });

  describe("Stripe customer creation", () => {
    it("carries the billing contact as the customer email", async () => {
      await seedBillingAccount({ orgId, billingEmail: "billing@example.com" });

      await createCheckoutSession(orgId, "starter", "http://localhost:3000");

      const create = requests.find((r) => r.method === "POST" && r.path === "/v1/customers");
      expect(create?.body?.email).toBe("billing@example.com");
    });

    it("falls back to the org owner when no contact is set", async () => {
      await seedBillingAccount({ orgId });

      await createCheckoutSession(orgId, "starter", "http://localhost:3000");

      const create = requests.find((r) => r.method === "POST" && r.path === "/v1/customers");
      expect(create?.body?.email).toBe("owner@example.com");
    });

    it("creates the customer without an email when nothing resolves", async () => {
      await seedBillingAccount({ orgId });
      seedOrgMembers(orgId, []);

      await createCheckoutSession(orgId, "starter", "http://localhost:3000");

      const create = requests.find((r) => r.method === "POST" && r.path === "/v1/customers");
      expect(create?.body?.email).toBeUndefined();
      expect(create?.body?.["metadata[orgId]"]).toBe(orgId);
    });
  });
});
