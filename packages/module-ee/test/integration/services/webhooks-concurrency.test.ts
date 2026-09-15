// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { beforeEach, describe, expect, it } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { billingAccounts, stripeEvents } from "../../../drizzle/schema.ts";
import { handleWebhook } from "../../../src/stripe/webhooks.ts";
import { getEeDb, truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { mockStorageLimitCalls, resetMockStorageLimits } from "../../helpers/mock-platform.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";
import {
  defaultSubscriptionResponse,
  generateWebhookEvent,
  invoiceEventObject,
  resetStripeMock,
  setSubscriptionResponse,
  setNextError,
} from "../../helpers/stripe.ts";

useEeTestSeams();

const orgId = "00000000-0000-4000-a000-000000000041";
const subscriptionId = "sub_concurrent_cancellation";
const customerId = "cus_concurrent_cancellation";
const subscription = () => ({
  ...defaultSubscriptionResponse(subscriptionId),
  customer: customerId,
  metadata: { orgId, planId: "starter" },
});

function deliver(type: string, object: object) {
  const event = generateWebhookEvent(
    { id: `evt_${type}`, type, data: { object } },
    "whsec_test_secret_for_webhook_verification",
  );
  return handleWebhook(event.body, event.signature);
}

function attachObject(type: string) {
  if (type === "customer.subscription.created") return subscription();
  if (type === "invoice.paid") {
    return invoiceEventObject({
      id: "in_concurrent",
      customer: customerId,
      subscription: subscriptionId,
    });
  }
  return {
    customer: customerId,
    subscription: subscriptionId,
    metadata: { orgId, planId: "starter" },
  };
}

async function expectCancelled() {
  const [account] = await getEeDb()
    .select()
    .from(billingAccounts)
    .where(eq(billingAccounts.orgId, orgId));
  expect(account).toMatchObject({
    planId: "free",
    stripeSubscriptionId: null,
    subscriptionStatus: null,
    creditQuota: 0,
  });
}

describe("Stripe cancellation versus subscription attachment", () => {
  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
    resetMockStorageLimits();
    await seedBillingAccount({
      orgId,
      planId: "starter",
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: "active",
      creditQuota: 20000,
    });
  });

  for (const type of [
    "checkout.session.completed",
    "invoice.paid",
    "customer.subscription.created",
  ]) {
    it(`${type}: deletion waits for an in-flight live read, then clears its grant`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      // Stripe answered active before cancellation, but the HTTP response is delayed.
      const snapshot = subscription();
      setSubscriptionResponse(async () => {
        entered.resolve();
        await release.promise;
        return snapshot;
      });
      let attachFinished = false;
      const attach = deliver(type, attachObject(type)).finally(() => {
        attachFinished = true;
      });
      let deletion: Promise<void> | undefined;
      try {
        // The created path must also retrieve live state. Before the fix it completes
        // without a read, so report that directly instead of hanging on the latch.
        await Promise.race([entered.promise, attach]);
        expect(attachFinished).toBe(false);
        let deleted = false;
        deletion = deliver("customer.subscription.deleted", {
          ...subscription(),
          status: "canceled",
        }).finally(() => {
          deleted = true;
        });
        // No arbitrary delay deciding the interleave: observe either the deletion
        // committing (the regression), or its real PostgreSQL advisory-lock wait.
        const deadline = Date.now() + 5000;
        while (!deleted) {
          const [row] = await getEeDb().execute<{ waiting: boolean }>(sql`
            SELECT EXISTS (SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())) AS waiting
          `);
          if (row?.waiting) break;
          if (Date.now() > deadline)
            throw new Error("Deletion neither completed nor waited on PostgreSQL");
          await Bun.sleep(5);
        }
      } finally {
        release.resolve();
        await Promise.all([attach, deletion]);
      }
      await expectCancelled();
      const claims = await getEeDb().select().from(stripeEvents);
      expect(claims).toHaveLength(2);
      expect(claims.every((claim) => claim.status === "done")).toBe(true);
    });

    it(`${type}: a late delivery cannot reattach an already cancelled subscription`, async () => {
      await deliver("customer.subscription.deleted", { ...subscription(), status: "canceled" });
      setSubscriptionResponse({ ...subscription(), status: "canceled" });
      await deliver(type, attachObject(type));
      await expectCancelled();
    });

    it(`${type}: failed retrieval releases the transaction lock and allows redelivery`, async () => {
      setNextError(400, { error: { type: "invalid_request_error", message: "retrieve failed" } });
      await expect(deliver(type, attachObject(type))).rejects.toThrow("retrieve failed");
      expect(await getEeDb().select().from(stripeEvents)).toHaveLength(0);
      expect(mockStorageLimitCalls).toHaveLength(0);

      await deliver("customer.subscription.deleted", { ...subscription(), status: "canceled" });
      setSubscriptionResponse({ ...subscription(), status: "canceled" });
      await deliver(type, attachObject(type));
      await expectCancelled();
      const claims = await getEeDb().select().from(stripeEvents);
      expect(claims).toHaveLength(2);
      expect(claims.every((claim) => claim.status === "done")).toBe(true);
    });
  }
});
