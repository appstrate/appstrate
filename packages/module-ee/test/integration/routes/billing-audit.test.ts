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

  it("records a manager replacement", async () => {
    await seedBillingAccount({ orgId });
    const res = await send("PUT", "/api/billing/managers", { user_ids: ["user-finance"] });
    expect(res.status).toBe(200);
    expect(mockAuditEntries).toEqual([
      {
        orgId,
        action: "billing.managers_updated",
        resourceType: "billing_account",
        resourceId: orgId,
        after: { userIds: ["user-finance"] },
      },
    ]);
  });

  it("records nothing for a refused manager replacement", async () => {
    await seedBillingAccount({ orgId });
    const res = await send("PUT", "/api/billing/managers", { user_ids: ["user-stranger"] });
    expect(res.status).toBe(400);
    expect(mockAuditEntries).toHaveLength(0);
  });

  it("records a contact change", async () => {
    await seedBillingAccount({ orgId });
    const res = await send("PATCH", "/api/billing/contact", {
      billing_email: "billing@example.com",
    });
    expect(res.status).toBe(200);
    expect(mockAuditEntries).toHaveLength(1);
    expect(mockAuditEntries[0]).toMatchObject({
      action: "billing.contact_updated",
      after: { billingEmail: "billing@example.com", billingCc: [] },
    });
  });

  it("records a checkout without the session URL", async () => {
    await seedBillingAccount({ orgId, stripeCustomerId: "cus_audit_001" });
    const res = await send("POST", "/api/billing/checkout", { plan_id: "starter" });
    expect(res.status).toBe(200);
    expect(mockAuditEntries).toHaveLength(1);
    expect(mockAuditEntries[0]).toMatchObject({
      action: "billing.checkout_created",
      after: { planId: "starter" },
    });
  });

  it("records a plan change", async () => {
    await seedBillingAccount({
      orgId,
      planId: "starter",
      stripeCustomerId: "cus_audit_002",
      stripeSubscriptionId: "sub_audit_002",
      subscriptionStatus: "active",
    });
    const res = await send("POST", "/api/billing/plan", { plan_id: "pro" });
    expect(res.status).toBe(200);
    expect(mockAuditEntries).toHaveLength(1);
    expect(mockAuditEntries[0]).toMatchObject({
      action: "billing.plan_changed",
      after: { planId: "pro" },
    });
  });
});
