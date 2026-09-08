import { describe, expect, it, beforeEach } from "bun:test";
import { truncateCloudTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { resetStripeMock, requests } from "../../helpers/stripe.ts";
import { createPortalSession } from "../../../src/stripe/portal.ts";

describe("createPortalSession", () => {
  const orgId = "00000000-0000-4000-a000-000000000030";
  const appUrl = "http://localhost:3000";

  beforeEach(async () => {
    await truncateCloudTables();
    resetStripeMock();
  });

  it("returns a portal URL for an existing customer", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: "cus_portal_001",
    });

    const url = await createPortalSession(orgId, appUrl);

    expect(url).toBe("https://billing.stripe.com/test");

    const portalRequests = requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/billing_portal/sessions",
    );
    expect(portalRequests).toHaveLength(1);
  });

  it("throws when stripeCustomerId is null", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: null,
    });

    await expect(createPortalSession(orgId, appUrl)).rejects.toThrow(
      "No Stripe customer for this org",
    );
  });

  it("throws when no billing account exists for the org", async () => {
    const unknownOrg = "00000000-0000-4000-a000-000000000099";

    await expect(createPortalSession(unknownOrg, appUrl)).rejects.toThrow(
      "No Stripe customer for this org",
    );
  });

  it("sends the correct customer and return_url to Stripe", async () => {
    await seedBillingAccount({
      orgId,
      stripeCustomerId: "cus_portal_002",
    });

    await createPortalSession(orgId, appUrl);

    const portalReq = requests.find(
      (r) => r.method === "POST" && r.path === "/v1/billing_portal/sessions",
    );
    expect(portalReq).toBeDefined();
    expect(portalReq!.body).toBeDefined();
    expect(portalReq!.body!["customer"]).toBe("cus_portal_002");
    expect(portalReq!.body!["return_url"]).toBe("http://localhost:3000/org-settings/billing");
  });
});
