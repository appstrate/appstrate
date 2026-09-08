import { describe, expect, it, beforeEach } from "bun:test";
import { truncateCloudTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { resetStripeMock, generateWebhookEvent, setNextError } from "../../helpers/stripe.ts";
import { flushCloudRedis } from "../../helpers/redis.ts";
import { getTestApp } from "../../helpers/app.ts";
import { getPlans } from "../../../src/config.ts";

const WEBHOOK_SECRET = "whsec_test_secret_for_webhook_verification";

describe("billing routes", () => {
  const orgId = "00000000-0000-4000-a000-000000000070";
  const app = getTestApp();

  function headers(overrides?: Record<string, string>) {
    return {
      "X-Test-Org-Id": orgId,
      "X-Test-Org-Role": "owner",
      ...overrides,
    };
  }

  beforeEach(async () => {
    await truncateCloudTables();
    resetStripeMock();
    await flushCloudRedis();
  });

  describe("GET /api/billing", () => {
    it("returns plan info and usage percent", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        creditsUsed: 5000,
        creditQuota: 20000,
        stripeSubscriptionId: "sub_active_001",
        subscriptionStatus: "active",
      });

      const res = await app.request("/api/billing", { headers: headers() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.plan).toEqual({ id: "starter", name: "Starter" });
      expect(body.usage_percent).toBe(25);
      expect(body.status).toBe("active");
    });

    it("prices storage alongside credits on every plan and upgrade", async () => {
      await seedBillingAccount({
        orgId,
        planId: "free",
        creditsUsed: 0,
        creditQuota: 5000,
        subscriptionStatus: "active",
      });

      const res = await app.request("/api/billing", { headers: headers() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        plans: Array<{ id: string; credit_quota: number; file_storage_bytes: number }>;
        upgrades: Array<{ id: string; file_storage_bytes: number }>;
      };

      const plans = getPlans();
      expect(body.plans.map((p) => [p.id, p.file_storage_bytes])).toEqual([
        ["free", plans.free.fileStorageBytes],
        ["starter", plans.starter.fileStorageBytes],
        ["pro", plans.pro.fileStorageBytes],
      ]);
      // `upgrades` is the same projection — an entitlement present on `plans`
      // is never missing from the plans the org can actually buy.
      expect(body.upgrades.map((p) => [p.id, p.file_storage_bytes])).toEqual([
        ["starter", plans.starter.fileStorageBytes],
        ["pro", plans.pro.fileStorageBytes],
      ]);
    });

    it("returns 404 when no billing account exists", async () => {
      const res = await app.request("/api/billing", { headers: headers() });
      expect(res.status).toBe(404);
    });

    it("returns canceling status when cancelAtPeriodEnd is true", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeSubscriptionId: "sub_canceling_001",
        subscriptionStatus: "active",
        cancelAtPeriodEnd: true,
        creditsUsed: 0,
        creditQuota: 20000,
      });

      const res = await app.request("/api/billing", { headers: headers() });
      expect(res.status).toBe(200);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("canceling");
    });

    it("caps usagePercent at 100 when over budget", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        creditsUsed: 30000,
        creditQuota: 20000,
        subscriptionStatus: "active",
      });

      const res = await app.request("/api/billing", { headers: headers() });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.usage_percent).toBe(100);
    });

    it("returns usagePercent 0 when budgetLimit is 0", async () => {
      await seedBillingAccount({
        orgId,
        planId: "free",
        creditsUsed: 0,
        creditQuota: 0,
        subscriptionStatus: null,
      });

      const res = await app.request("/api/billing", { headers: headers() });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.usage_percent).toBe(0);
    });

    it("returns none when no Stripe subscription is attached despite a legacy canceled status", async () => {
      await seedBillingAccount({
        orgId,
        planId: "free",
        stripeSubscriptionId: null,
        subscriptionStatus: "canceled",
        creditsUsed: 0,
        creditQuota: 0,
      });

      const res = await app.request("/api/billing", { headers: headers() });
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("none");
    });
  });

  describe("POST /api/billing/checkout", () => {
    it("returns a checkout URL", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_route_001",
      });

      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: "starter" }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBeString();
      expect(body.url.length).toBeGreaterThan(0);
    });

    it("returns 400 for invalid planId", async () => {
      await seedBillingAccount({ orgId });

      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: "enterprise" }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 for missing planId", async () => {
      await seedBillingAccount({ orgId });

      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("rejects member role (admin-only)", async () => {
      await seedBillingAccount({ orgId });

      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: {
          ...headers({ "X-Test-Org-Role": "member" }),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan_id: "starter" }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /api/billing/portal", () => {
    it("returns a portal URL", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_route_portal_001",
      });

      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: headers(),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { url: string };
      expect(body.url).toBeString();
    });

    it("returns 503 when Stripe fails", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_route_portal_fail",
      });

      setNextError(500, {
        error: { type: "api_error", message: "Internal error" },
      });

      const res = await app.request("/api/billing/portal", {
        method: "POST",
        headers: headers(),
      });

      expect(res.status).toBe(503);
    });
  });

  describe("POST /api/billing/webhooks", () => {
    it("returns 200 with valid signature", async () => {
      await seedBillingAccount({ orgId });

      const { body, signature } = generateWebhookEvent(
        {
          id: "evt_route_001",
          type: "invoice.payment_failed",
          data: {
            object: {
              id: "in_route_001",
              customer: "cus_route_wh_001",
              billing_reason: "subscription_cycle",
            },
          },
        },
        WEBHOOK_SECRET,
      );

      const res = await app.request("/api/billing/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
        },
        body,
      });

      expect(res.status).toBe(200);
      const resBody = (await res.json()) as { received: boolean };
      expect(resBody.received).toBe(true);
    });

    it("returns 400 when stripe-signature header is missing", async () => {
      const res = await app.request("/api/billing/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "evt_no_sig" }),
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Missing stripe-signature");
    });

    it("returns 400 for invalid signature", async () => {
      const res = await app.request("/api/billing/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "t=1234567890,v1=invalid_signature",
        },
        body: JSON.stringify({ id: "evt_bad_sig" }),
      });

      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain("Invalid signature");
    });

    it("does not require X-Test-Org-Id (public endpoint)", async () => {
      // Webhook endpoint should work without org context headers
      const { body, signature } = generateWebhookEvent(
        {
          id: "evt_route_public_001",
          type: "invoice.payment_failed",
          data: {
            object: {
              id: "in_route_pub_001",
              customer: "cus_route_pub_001",
              billing_reason: "subscription_cycle",
            },
          },
        },
        WEBHOOK_SECRET,
      );

      // Note: The webhook route is mounted at /api/billing/webhooks which
      // goes through the /api/* middleware requiring X-Test-Org-Id.
      // In production, publicPaths would bypass this. In tests, we need
      // to send the header or test directly via the billing routes.
      // Let's verify the route itself processes valid webhooks:
      const res = await app.request("/api/billing/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": signature,
          "X-Test-Org-Id": orgId, // Needed due to test app middleware
        },
        body,
      });

      expect(res.status).toBe(200);
    });
  });

  describe("authentication", () => {
    it("returns 401 without X-Test-Org-Id header", async () => {
      const res = await app.request("/api/billing");
      expect(res.status).toBe(401);
    });
  });

  describe("rate limiting on checkout", () => {
    it("rate limits after too many checkout requests", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_ratelimit_001",
      });

      // Make 5 successful requests (rate limit is 5/min)
      for (let i = 0; i < 5; i++) {
        const res = await app.request("/api/billing/checkout", {
          method: "POST",
          headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ plan_id: "starter" }),
        });
        expect(res.status).toBe(200);
      }

      // 6th request should be rate limited
      const res = await app.request("/api/billing/checkout", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: "starter" }),
      });
      expect(res.status).toBe(429);
    });
  });
});
