// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { resetStripeMock, setCheckoutResponse, requests } from "../../helpers/stripe.ts";
import { createCheckoutSession } from "../../../src/stripe/checkout.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

describe("createCheckoutSession", () => {
  const orgId = "00000000-0000-4000-a000-000000000020";
  const appUrl = "http://localhost:3000";

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
  });

  it("creates a checkout session URL for an existing customer", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: "cus_existing_001",
    });

    const url = await createCheckoutSession(orgId, "starter", appUrl);

    expect(url).toBe("https://checkout.stripe.com/test");

    // Should NOT create a new customer
    const customerRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/customers",
    );
    expect(customerRequests).toHaveLength(0);

    // Should create a checkout session
    const checkoutRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/checkout/sessions",
    );
    expect(checkoutRequests).toHaveLength(1);
  });

  it("creates a new customer first when stripeCustomerId is null", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: null,
    });

    const url = await createCheckoutSession(orgId, "starter", appUrl);

    expect(url).toBe("https://checkout.stripe.com/test");

    // Should create a customer
    const customerRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/customers",
    );
    expect(customerRequests).toHaveLength(1);

    // Then create a checkout session
    const checkoutRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/checkout/sessions",
    );
    expect(checkoutRequests).toHaveLength(1);
  });

  it("throws for an invalid plan (free has no stripePriceId)", async () => {
    await seedBillingAccount({ orgId });

    await expect(createCheckoutSession(orgId, "free", appUrl)).rejects.toThrow(
      "Invalid plan: free",
    );
  });

  it("throws for a non-existent plan", async () => {
    await seedBillingAccount({ orgId });

    await expect(createCheckoutSession(orgId, "enterprise", appUrl)).rejects.toThrow(
      "Invalid plan: enterprise",
    );
  });

  it("refuses an org with no billing account as a 404, not a retryable failure", async () => {
    const unknownOrg = "00000000-0000-4000-a000-000000000099";

    await expect(createCheckoutSession(unknownOrg, "starter", appUrl)).rejects.toMatchObject({
      status: 404,
      code: "no_billing_account",
    });
  });

  it("throws when Stripe returns a session without a URL", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: "cus_existing_002",
    });

    setCheckoutResponse({
      id: "cs_test_no_url",
      object: "checkout.session",
      // No url field
    });

    await expect(createCheckoutSession(orgId, "starter", appUrl)).rejects.toThrow(
      "Stripe returned a session without a URL",
    );
  });

  it("sends correct line_items and metadata to Stripe", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: "cus_existing_003",
    });

    await createCheckoutSession(orgId, "pro", appUrl);

    const checkoutReq = requests.find(
      (r) => r.method === "POST" && r.path === "/v1/checkout/sessions",
    );
    expect(checkoutReq).toBeDefined();
    expect(checkoutReq!.body).toBeDefined();
    // Stripe SDK sends form-encoded data; verify key fields
    const body = checkoutReq!.body!;
    expect(body["metadata[orgId]"]).toBe(orgId);
    expect(body["metadata[planId]"]).toBe("pro");
  });

  /**
   * Which door a subscribing org goes through is decided by whether STRIPE
   * still holds a subscription, not by whether the account row carries an id.
   */
  describe("an account that already carries a subscription id", () => {
    it("refuses a checkout while Stripe still holds the subscription", async () => {
      // `unpaid`: Stripe stopped collecting but the subscription object is
      // still there, so a second checkout would bill the org twice. The
      // Customer Portal is the way back.
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_held_001",
        stripeSubscriptionId: "sub_held_001",
        subscriptionStatus: "unpaid",
      });

      await expect(createCheckoutSession(orgId, "pro", appUrl)).rejects.toMatchObject({
        status: 409,
        code: "subscription_exists",
      });
      expect(requests.filter((r) => r.path === "/v1/checkout/sessions")).toHaveLength(0);
    });

    it("refuses a checkout while the first payment is still pending", async () => {
      // `incomplete` is HELD: Stripe may yet activate the subscription, so a
      // second checkout can end with two live subscriptions on one org.
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_incomplete_001",
        stripeSubscriptionId: "sub_incomplete_001",
        subscriptionStatus: "incomplete",
      });

      await expect(createCheckoutSession(orgId, "pro", appUrl)).rejects.toMatchObject({
        status: 409,
        code: "subscription_exists",
      });
      expect(requests.filter((r) => r.path === "/v1/checkout/sessions")).toHaveLength(0);
    });

    it("opens a checkout when the id names a subscription Stripe no longer holds", async () => {
      // Same non-null id, terminal status: only `customer.subscription.deleted`
      // nulls the column, so a lost or late one leaves this row behind. The org
      // must still be able to subscribe again.
      await seedBillingAccount({
        orgId,
        planId: "free",
        stripeCustomerId: "cus_dead_001",
        stripeSubscriptionId: "sub_dead_001",
        subscriptionStatus: "canceled",
      });

      const url = await createCheckoutSession(orgId, "pro", appUrl);
      expect(url).toBe("https://checkout.stripe.com/test");
      expect(requests.filter((r) => r.path === "/v1/checkout/sessions")).toHaveLength(1);
    });
  });

  it("creates checkout for pro plan", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: "cus_existing_004",
    });

    const url = await createCheckoutSession(orgId, "pro", appUrl);
    expect(url).toBeString();
    expect(url.length).toBeGreaterThan(0);
  });
});
