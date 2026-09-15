// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { beforeEach, describe, expect, it } from "bun:test";
import { getEeDb, truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import {
  generateWebhookEvent,
  setSubscriptionResponse,
  resetStripeMock,
} from "../../helpers/stripe.ts";
import { handleWebhook } from "../../../src/stripe/webhooks.ts";
import { billingAccounts } from "../../../drizzle/schema.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();
const orgId = "00000000-0000-4000-a000-000000143888";
const subscriptionId = "sub_rereview_stale";
const quota = { starter: 20000, pro: 80000 };
const currentTime = Math.floor(Date.now() / 1000);
const subscription = (plan: "starter" | "pro") => ({
  id: subscriptionId,
  object: "subscription" as const,
  customer: "cus_rereview_stale",
  status: "active" as const,
  cancel_at_period_end: false,
  metadata: { orgId, planId: "starter" },
  items: {
    data: [
      {
        id: "si_rereview_stale",
        price: { id: `price_${plan}_test` },
        current_period_end: currentTime + 2592000,
      },
    ],
  },
});
async function deliver(type: string, object: object, suffix: string, created: number) {
  const signed = generateWebhookEvent(
    { id: `evt_rereview_${suffix}`, type, created, data: { object } },
    "whsec_test_secret_for_webhook_verification",
  );
  await handleWebhook(signed.body, signed.signature);
}
async function account() {
  return (await getEeDb().select().from(billingAccounts))[0]!;
}
describe("current quota survives older delivery for the same subscription", () => {
  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
  });
  for (const [current, previous] of [
    ["pro", "starter"],
    ["starter", "pro"],
  ] as const) {
    it(`keeps ${current} quota after stale ${previous} subscription.updated`, async () => {
      await seedBillingAccount({
        orgId,
        planId: previous,
        stripeCustomerId: "cus_rereview_stale",
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: "active",
        creditQuota: quota[previous],
        creditsUsed: 20000,
      });
      setSubscriptionResponse(subscription(current));
      await deliver("customer.subscription.updated", subscription(current), "new", currentTime);
      expect((await account()).creditQuota).toBe(quota[current]);
      setSubscriptionResponse(subscription(current));
      await deliver(
        "customer.subscription.updated",
        subscription(previous),
        "old",
        currentTime - 600,
      );
      const after = await account();
      expect(after.creditQuota).toBe(quota[current]);
      expect(after.planId).toBe(current);
      expect(after.creditsUsed).toBe(20000);
    });
  }
  it("keeps the live Pro quota after a delayed original Starter checkout", async () => {
    await seedBillingAccount({
      orgId,
      planId: "pro",
      stripeCustomerId: "cus_rereview_stale",
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: "active",
      creditQuota: 80000,
      creditsUsed: 20000,
    });
    setSubscriptionResponse(subscription("pro"));
    await deliver(
      "checkout.session.completed",
      {
        id: "cs_rereview_stale",
        customer: "cus_rereview_stale",
        subscription: subscriptionId,
        metadata: { orgId, planId: "starter" },
      },
      "checkout_old",
      currentTime - 600,
    );
    const after = await account();
    expect(after.creditQuota).toBe(80000);
    expect(after.planId).toBe("pro");
    expect(after.creditsUsed).toBe(20000);
  });
  it("does not attach an unknown current price using old creation metadata", async () => {
    await seedBillingAccount({ orgId, planId: "free", creditQuota: 0 });
    const live = { ...subscription("pro"), items: { data: [{ price: { id: "price_unknown" } }] } };
    setSubscriptionResponse(live);
    await deliver(
      "customer.subscription.created",
      subscription("pro"),
      "unknown_price",
      currentTime,
    );
    const after = await account();
    expect(after.planId).toBe("free");
    expect(after.stripeSubscriptionId).toBeNull();
    expect(after.creditQuota).toBe(0);
  });
});
