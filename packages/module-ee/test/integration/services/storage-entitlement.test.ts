// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Plan → storage-entitlement projection.
 *
 * EE owns the platform's per-org document storage limit and projects the
 * billing plan onto it via `PlatformServices.setFileStorageLimit` (the
 * only platform WRITE EE performs — recorded by the mock, no platform DB).
 * Covered here:
 *   - the sync service itself (plan mapping, unknown plan, missing account,
 *     platform write failure)
 *   - the full-fleet reconcile (backfill/repair)
 *   - the transition call sites: org creation and the Stripe webhook plan
 *     transitions (checkout upgrade, plan change, terminal cancellation)
 *   - the throttled reconcile on the billing tick (hourly gate: first tick
 *     starts a pass, the next one doesn't; the tick never waits for it)
 */

import { describe, expect, it, beforeEach, spyOn } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount, seedBillingCursor } from "../../helpers/seed.ts";
import { resetStripeMock, generateWebhookEvent } from "../../helpers/stripe.ts";
import { mockStorageLimitCalls, resetMockStorageLimits } from "../../helpers/mock-platform.ts";
import { setMockStorageLimitError, setMockStorageLimitHook } from "../../helpers/mock-platform.ts";
import { eq } from "drizzle-orm";
import { getEeDb } from "../../../src/db.ts";
import { billingAccounts } from "../../../drizzle/schema.ts";
import {
  syncOrgStorageEntitlement,
  resyncAllStorageEntitlements,
  storageEntitlementForPlan,
} from "../../../src/billing/storage-entitlement.ts";
import { onOrgCreate } from "../../../src/onboarding/post-signup.ts";
import { handleWebhook } from "../../../src/stripe/webhooks.ts";
import {
  runBillingSweepTick,
  drainBillingSweeper,
  startBillingSweeper,
  stopBillingSweeper,
  _resetBillingSweeperForTests,
} from "../../../src/billing/billing-sweeper.ts";
import { setMockLedgerListHook } from "../../helpers/mock-platform.ts";
import { logger } from "../../../src/logger.ts";
import { getPlans, GIB } from "../../../src/config.ts";
import { _resetEeEnvForTests } from "../../../src/env.ts";
import { useEeReconciliationEnv, useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();
useEeReconciliationEnv();

const WEBHOOK_SECRET = "whsec_test_secret_for_webhook_verification";

describe("storage entitlement", () => {
  const orgId = "00000000-0000-4000-a000-000000000060";

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
    resetMockStorageLimits();
  });

  function signedEvent(payload: object) {
    return generateWebhookEvent(payload, WEBHOOK_SECRET);
  }

  describe("storageEntitlementForPlan", () => {
    it("maps each plan to its byte entitlement and unknown plans to free", () => {
      const plans = getPlans();
      expect(storageEntitlementForPlan("free")).toBe(plans.free.fileStorageBytes);
      expect(storageEntitlementForPlan("starter")).toBe(plans.starter.fileStorageBytes);
      expect(storageEntitlementForPlan("pro")).toBe(plans.pro.fileStorageBytes);
      expect(storageEntitlementForPlan("legacy-unknown")).toBe(plans.free.fileStorageBytes);
    });
  });

  describe("syncOrgStorageEntitlement", () => {
    it("projects the account's plan onto the platform limit", async () => {
      await seedBillingAccount({ orgId, planId: "starter" });

      const ok = await syncOrgStorageEntitlement(orgId);

      expect(ok).toBe(true);
      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 20 * GIB }]);
    });

    it("does nothing for an org without a billing account", async () => {
      const ok = await syncOrgStorageEntitlement(orgId);

      expect(ok).toBe(false);
      expect(mockStorageLimitCalls).toHaveLength(0);
    });

    it("swallows a platform write failure (best-effort — resync repairs)", async () => {
      await seedBillingAccount({ orgId, planId: "pro" });
      setMockStorageLimitError();

      const ok = await syncOrgStorageEntitlement(orgId);

      expect(ok).toBe(false);
      expect(mockStorageLimitCalls).toHaveLength(0);
    });
  });

  describe("resyncAllStorageEntitlements", () => {
    it("rewrites every account's entitlement (backfill + repair)", async () => {
      const orgA = "00000000-0000-4000-a000-000000000061";
      const orgB = "00000000-0000-4000-a000-000000000062";
      await seedBillingAccount({ orgId: orgA, planId: "free" });
      await seedBillingAccount({ orgId: orgB, planId: "pro" });

      const result = await resyncAllStorageEntitlements();

      expect(result).toEqual({ synced: 2, failed: 0, skipped: 0 });
      expect(mockStorageLimitCalls).toContainEqual({ orgId: orgA, bytes: 1 * GIB });
      expect(mockStorageLimitCalls).toContainEqual({ orgId: orgB, bytes: 100 * GIB });
    });

    it("does not overwrite a plan transition landing mid-write (stale-write guard)", async () => {
      await seedBillingAccount({ orgId, planId: "starter" });

      // Simulate a Stripe webhook upgrading the plan WHILE the reconcile's
      // platform write for this org is in flight: the reconcile read "starter",
      // the webhook commits "pro", the reconcile's 20 GiB write is now stale.
      let fired = false;
      setMockStorageLimitHook(async () => {
        if (fired) return;
        fired = true;
        await getEeDb()
          .update(billingAccounts)
          .set({ planId: "pro" })
          .where(eq(billingAccounts.orgId, orgId));
      });

      const result = await resyncAllStorageEntitlements();

      expect(result).toEqual({ synced: 1, failed: 0, skipped: 0 });
      // The post-write recheck detected the transition and re-projected the
      // fresh plan — the LAST write must reflect "pro", not the stale snapshot.
      expect(mockStorageLimitCalls.at(-1)).toEqual({ orgId, bytes: 100 * GIB });
    });

    it("bounds the stale-write retry — a flapping plan never loops", async () => {
      await seedBillingAccount({ orgId, planId: "starter" });

      // Adversarial: the plan changes during EVERY write. The projection must
      // retry exactly once (2 writes total) then defer to the next sync.
      const flip = ["pro", "starter", "pro", "starter"];
      let i = 0;
      setMockStorageLimitHook(async () => {
        const next = flip[i++ % flip.length]!;
        await getEeDb()
          .update(billingAccounts)
          .set({ planId: next })
          .where(eq(billingAccounts.orgId, orgId));
      });

      const result = await resyncAllStorageEntitlements();

      expect(result).toEqual({ synced: 1, failed: 0, skipped: 0 });
      expect(mockStorageLimitCalls).toHaveLength(2);
    });

    it("counts per-org failures without aborting the pass", async () => {
      const orgA = "00000000-0000-4000-a000-000000000063";
      const orgB = "00000000-0000-4000-a000-000000000064";
      await seedBillingAccount({ orgId: orgA, planId: "free" });
      await seedBillingAccount({ orgId: orgB, planId: "starter" });
      setMockStorageLimitError(); // first write throws, second lands

      const result = await resyncAllStorageEntitlements();

      expect(result).toEqual({ synced: 1, failed: 1, skipped: 0 });
      expect(mockStorageLimitCalls).toHaveLength(1);
    });
  });

  describe("transition call sites", () => {
    it("org creation projects the free-plan limit — even for a 0-credit duplicate claim", async () => {
      await onOrgCreate(orgId, "storage-first@example.com");
      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 1 * GIB }]);

      // Same email, second org: credits are 0 (anti-abuse) but storage is a
      // plan entitlement — the free limit still applies.
      resetMockStorageLimits();
      const orgId2 = "00000000-0000-4000-a000-000000000065";
      await onOrgCreate(orgId2, "storage-first@example.com");
      expect(mockStorageLimitCalls).toEqual([{ orgId: orgId2, bytes: 1 * GIB }]);
    });

    it("checkout.session.completed projects the purchased plan", async () => {
      await seedBillingAccount({ orgId, planId: "free" });

      const { body, signature } = signedEvent({
        id: "evt_storage_checkout_001",
        type: "checkout.session.completed",
        data: {
          object: {
            customer: "cus_storage_001",
            subscription: "sub_storage_001",
            metadata: { orgId, planId: "starter" },
          },
        },
      });
      await handleWebhook(body, signature);

      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 20 * GIB }]);
    });

    it("customer.subscription.updated re-projects after a plan change", async () => {
      await seedBillingAccount({
        orgId,
        planId: "starter",
        stripeCustomerId: "cus_storage_002",
        stripeSubscriptionId: "sub_storage_002",
        subscriptionStatus: "active",
      });

      const { body, signature } = signedEvent({
        id: "evt_storage_sub_updated_001",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_storage_002",
            customer: "cus_storage_002",
            status: "active",
            cancel_at_period_end: false,
            metadata: { orgId, planId: "starter" },
            items: {
              object: "list",
              data: [
                {
                  id: "si_storage_002",
                  current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
                  price: { id: "price_pro_test" },
                },
              ],
            },
          },
        },
      });
      await handleWebhook(body, signature);

      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 100 * GIB }]);
    });

    it("customer.subscription.deleted drops to the free-plan limit (no eviction — ceiling only)", async () => {
      await seedBillingAccount({
        orgId,
        planId: "pro",
        stripeCustomerId: "cus_storage_003",
        stripeSubscriptionId: "sub_storage_003",
        subscriptionStatus: "active",
      });

      const { body, signature } = signedEvent({
        id: "evt_storage_sub_deleted_001",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_storage_003",
            customer: "cus_storage_003",
            status: "canceled",
            metadata: { orgId, planId: "pro" },
          },
        },
      });
      await handleWebhook(body, signature);

      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 1 * GIB }]);
    });
  });

  describe("bounded concurrency", () => {
    it("never runs more than `concurrency` org projections at a time", async () => {
      // Strictly serial, this pass froze the billing tick it used to ride;
      // unbounded, it would burst one platform write per org. Assert the cap by
      // watching how many writes are in flight simultaneously.
      for (let i = 0; i < 12; i++) {
        await seedBillingAccount({
          orgId: `00000000-0000-4000-a000-0000000006${String(i).padStart(2, "0")}`,
          planId: "starter",
        });
      }

      let inFlight = 0;
      let peak = 0;
      setMockStorageLimitHook(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      });

      const result = await resyncAllStorageEntitlements(4);

      expect(result.synced).toBe(12);
      expect(peak).toBeGreaterThan(1); // genuinely parallel
      expect(peak).toBeLessThanOrEqual(4); // and capped
    });
  });

  describe("throttled reconcile on the billing tick", () => {
    beforeEach(() => {
      process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
      _resetEeEnvForTests();
      _resetBillingSweeperForTests();
    });

    it("rides the tick on an hourly throttle", async () => {
      await seedBillingAccount({ orgId, planId: "starter" });

      await runBillingSweepTick();
      await drainBillingSweeper();
      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 20 * GIB }]);

      // A second tick inside the same window must not rewrite the whole fleet
      // again — the reconcile is hourly, the sweep is every 5 minutes.
      resetMockStorageLimits();
      await runBillingSweepTick();
      await drainBillingSweeper();
      expect(mockStorageLimitCalls).toHaveLength(0);
    });

    it("does not delay the sweep — the pass is started, not awaited", async () => {
      // REGRESSION: the reconcile used to be awaited inline before the tick
      // scheduled the next sweep, so a fleet-wide pass (one platform write per
      // org) pushed billing out by however long it took.
      await seedBillingAccount({ orgId, planId: "starter" });
      let markEntered!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (markEntered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      setMockStorageLimitHook(async () => {
        markEntered();
        await gate;
      });

      await runBillingSweepTick();

      // The tick has already returned (so `scheduleNext` would already have run)
      // while the entitlement write is still blocked mid-flight.
      await entered;
      expect(mockStorageLimitCalls).toHaveLength(0);

      release();
      await drainBillingSweeper();
      setMockStorageLimitHook(null);
      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 20 * GIB }]);
    });

    it("reports a pass that repaired nothing at error level", async () => {
      // Per-org errors are swallowed by `projectOrgEntitlement`, so a pass where
      // EVERY org failed still resolves "normally". `failed` is the only witness.
      await seedBillingAccount({ orgId, planId: "starter" });
      setMockStorageLimitError();

      const errorSpy = spyOn(logger, "error");
      let failureErrors: unknown[][];
      try {
        await runBillingSweepTick();
        await drainBillingSweeper();
        failureErrors = errorSpy.mock.calls.filter(
          ([msg]) => typeof msg === "string" && msg.includes("unrepaired"),
        );
      } finally {
        errorSpy.mockRestore();
      }

      expect(failureErrors!).toHaveLength(1);
      expect(failureErrors![0]![1]).toMatchObject({ synced: 0, failed: 1 });
    });
  });
});

describe("shutdown drain", () => {
  const orgId = "00000000-0000-4000-a000-000000000062";

  beforeEach(async () => {
    await truncateEeTables();
    resetMockStorageLimits();
    process.env.EE_RECONCILIATION_BATCH_SIZE = "100";
    process.env.EE_RECONCILIATION_INTERVAL_SECONDS = "1";
    _resetEeEnvForTests();
    _resetBillingSweeperForTests();
  });

  it("REGRESSION: waits for a reconcile the tick started while the drain was already waiting", async () => {
    // The tick STARTS the reconcile from inside the very promise a drain entered
    // mid-sweep is awaiting. A drain that snapshotted [sweep, resync] once, at
    // entry, would therefore see no resync, return the instant the sweep
    // finished, and let `closeEeDb()` run underneath a reconcile that began in
    // between. Re-reading after every wait is what closes it.
    await seedBillingAccount({ orgId, planId: "starter" });
    // Seed the cursor so the FIRST tick reads the ledger (and blocks in the hook
    // below) instead of returning early to seed it. The reconcile has to still
    // be un-started when the drain is entered — that is the whole race.
    await seedBillingCursor(0);

    let releaseSweep!: () => void;
    let sweepEntered!: () => void;
    const inSweep = new Promise<void>((resolve) => (sweepEntered = resolve));
    const sweepGate = new Promise<void>((resolve) => (releaseSweep = resolve));
    setMockLedgerListHook(async () => {
      sweepEntered();
      await sweepGate;
    });

    let releaseResync!: () => void;
    const resyncGate = new Promise<void>((resolve) => (releaseResync = resolve));
    setMockStorageLimitHook(() => resyncGate);

    try {
      startBillingSweeper();
      await inSweep;

      // Shutdown order: clear the timer, then drain. At this instant the tick is
      // inside the sweep and has NOT yet started the reconcile.
      stopBillingSweeper();
      let drained = false;
      const drain = drainBillingSweeper().then(() => {
        drained = true;
      });

      releaseSweep();
      // The tick finishes the sweep, starts the reconcile, and returns. The
      // reconcile is still blocked, so the drain must still be waiting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(drained).toBe(false);

      releaseResync();
      await drain;
      expect(drained).toBe(true);
      expect(mockStorageLimitCalls).toEqual([{ orgId, bytes: 20 * GIB }]);
    } finally {
      stopBillingSweeper();
      setMockLedgerListHook(null);
      setMockStorageLimitHook(null);
    }
  });
});
