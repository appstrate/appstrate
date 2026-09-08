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

  it("throws when no billing account exists for the org", async () => {
    const unknownOrg = "00000000-0000-4000-a000-000000000099";

    await expect(createCheckoutSession(unknownOrg, "starter", appUrl)).rejects.toThrow(
      "No billing account for org",
    );
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
