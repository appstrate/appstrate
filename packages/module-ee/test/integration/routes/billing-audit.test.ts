// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { seedOrgMembers } from "../../helpers/org-queries.ts";
import { resetStripeMock } from "../../helpers/stripe.ts";
import { flushEeRedis } from "../../helpers/redis.ts";
import { getTestApp } from "../../helpers/app.ts";
import { mockAuditEntries, resetMockAudit } from "../../helpers/mock-platform.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

/**
 * Billing mutations reach the platform audit trail through
 * `services.audit.record` — the only way a module can write `audit_events`.
 */
describe("billing audit trail", () => {
  const orgId = "00000000-0000-4000-a000-0000000000d0";
  const app = getTestApp();

  function send(method: string, path: string, body: unknown) {
    return app.request(path, {
      method,
      headers: {
        "X-Test-Org-Id": orgId,
        "X-Test-Org-Role": "owner",
        "X-Test-User-Id": "user-owner",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
    await flushEeRedis();
    resetMockAudit();
    seedOrgMembers(orgId, [
      { userId: "user-owner", email: "owner@example.com", role: "owner" },
      { userId: "user-finance", email: "finance@example.com", role: "member" },
    ]);
  });

  // `after` compared whole: a checkout's audit must not carry the Stripe session URL.
  it.each([
    [
      "billing.managers_updated",
      {},
      "PUT",
      "/api/billing/managers",
      { user_ids: ["user-finance"] },
      { userIds: ["user-finance"] },
    ],
    [
      "billing.contact_updated",
      {},
      "PATCH",
      "/api/billing/contact",
      { billing_email: "billing@example.com" },
      { billingEmail: "billing@example.com", billingCc: [] },
    ],
    [
      "billing.checkout_created",
      { stripeCustomerId: "cus_audit_001" },
      "POST",
      "/api/billing/checkout",
      { plan_id: "starter" },
      { planId: "starter" },
    ],
    [
      "billing.plan_changed",
      {
        planId: "starter",
        stripeCustomerId: "cus_audit_002",
        stripeSubscriptionId: "sub_audit_002",
        subscriptionStatus: "active",
      },
      "POST",
      "/api/billing/plan",
      { plan_id: "pro" },
      { planId: "pro" },
    ],
  ] as const)("records %s", async (action, account, method, path, body, after) => {
    await seedBillingAccount({ orgId, ...account });
    const res = await send(method, path, body);
    expect(res.status).toBe(200);
    expect(mockAuditEntries).toEqual([
      { orgId, action, resourceType: "billing_account", resourceId: orgId, after },
    ]);
  });

  it("records nothing for a refused manager replacement", async () => {
    await seedBillingAccount({ orgId });
    const res = await send("PUT", "/api/billing/managers", { user_ids: ["user-stranger"] });
    expect(res.status).toBe(400);
    expect(mockAuditEntries).toHaveLength(0);
  });
});
