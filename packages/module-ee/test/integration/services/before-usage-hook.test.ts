// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Unified `beforeUsage` admission gate.
 *
 * One hook gates both usage surfaces (discriminated union). The platform
 * dispatches on EVERY metered usage attempt and never pre-filters "free"
 * operations: it reports neutral execution facts (`credentialSource`,
 * `executionPlane`, `timeoutSeconds`) and this module quotes them, then gates on
 * the total. A run's model estimate carries a concurrency term (projected
 * in-flight count, including the run being admitted); a chat turn is a flat
 * per-turn estimate. Compute is quoted as a separate component whose rate ships
 * at 0 in phase 1. Billing itself never happens here — the cursor sweep is the
 * biller.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { getEeDb, truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { billingAccounts } from "../../../drizzle/schema.ts";
import eeModule from "../../../src/index.ts";
import {
  ESTIMATED_MODEL_CREDITS_PER_RUN,
  ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN,
} from "../../../src/config.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

const orgId = "00000000-0000-4000-a000-000000000900";

function beforeUsage(
  ...args: Parameters<NonNullable<NonNullable<typeof eeModule.hooks>["beforeUsage"]>>
) {
  return eeModule.hooks!.beforeUsage!(...args);
}

describe("beforeUsage hook", () => {
  beforeEach(async () => {
    await truncateEeTables();
  });

  it("allows a system run when the org has credits (null)", async () => {
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 5000 });
    const result = await beforeUsage({
      orgId,
      context: "run",
      packageId: "@x/agent",
      runningCount: 1,
      credentialSource: "system",
      executionPlane: "platform",
      timeoutSeconds: 600,
    });
    expect(result).toBeNull();
  });

  it("rejects a run with 402 when the in-flight estimate exceeds the quota", async () => {
    // Remaining sits one credit below one run's model estimate.
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 5000 - ESTIMATED_MODEL_CREDITS_PER_RUN + 1,
      creditQuota: 5000,
    });
    const result = await beforeUsage({
      orgId,
      context: "run",
      packageId: "@x/agent",
      runningCount: 1,
      credentialSource: "system",
      executionPlane: "platform",
      timeoutSeconds: 600,
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(402);
    expect(result!.code).toBe("quota_exceeded");
  });

  it("admits a system run whose estimate exactly equals the remaining balance", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 5000 - ESTIMATED_MODEL_CREDITS_PER_RUN,
      creditQuota: 5000,
    });
    const result = await beforeUsage({
      orgId,
      context: "run",
      packageId: "@x/agent",
      runningCount: 1,
      credentialSource: "system",
      executionPlane: "platform",
      timeoutSeconds: 600,
    });
    expect(result).toBeNull();
  });

  it("allows a chat turn when the org has credits (null)", async () => {
    await seedBillingAccount({ orgId, creditsUsed: 0, creditQuota: 5000 });
    const result = await beforeUsage({
      orgId,
      context: "chat",
      sessionId: "sess-1",
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(result).toBeNull();
  });

  it("gates a chat turn on the flat per-turn estimate (402 one credit short)", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 5000 - ESTIMATED_MODEL_CREDITS_PER_CHAT_TURN + 1,
      creditQuota: 5000,
    });
    const result = await beforeUsage({
      orgId,
      context: "chat",
      sessionId: null,
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(402);
  });

  it("allows a chat turn that a run would have rejected (smaller estimate)", async () => {
    // Remaining is one credit short of the run estimate but far above the chat
    // estimate: the chat turn fits, the run does not.
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 5000 - ESTIMATED_MODEL_CREDITS_PER_RUN + 1,
      creditQuota: 5000,
    });
    const chat = await beforeUsage({
      orgId,
      context: "chat",
      sessionId: "sess-2",
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(chat).toBeNull();
  });

  it("rejects with 402 when the org has no billing account and the quote is positive", async () => {
    const result = await beforeUsage({
      orgId,
      context: "chat",
      sessionId: "sess-3",
      credentialSource: "system",
      executionPlane: "platform",
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe(402);
    // `no_account` rides with the balance code: it only fires for a positive
    // quote, so the remedy is the same as an exhausted balance.
    expect(result!.code).toBe("quota_exceeded");
  });

  it("allows a zero-quote operation when the org has no billing account", async () => {
    // An absent account cannot owe anything; a zero-cost platform BYOK chat
    // turn must not be rejected for a missing row.
    const result = await beforeUsage({
      orgId,
      context: "chat",
      sessionId: "sess-4",
      credentialSource: "org",
      executionPlane: "platform",
    });
    expect(result).toBeNull();
  });

  describe("quote-based admission", () => {
    it("allows a platform BYOK run even with a zero credit quota", async () => {
      // Acceptance 1: the org funds the inference; compute is unbilled in phase
      // 1, so the quote is 0 and an exhausted quota is irrelevant.
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "active",
        creditsUsed: 0,
        creditQuota: 0,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 3,
        credentialSource: "org",
        executionPlane: "platform",
        timeoutSeconds: 900,
      });
      expect(result).toBeNull();
    });

    it("allows a zero-cost platform BYOK run after the paid subscription is canceled", async () => {
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "canceled",
        creditsUsed: 0,
        creditQuota: 0,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "org",
        executionPlane: "platform",
        timeoutSeconds: 900,
      });
      expect(result).toBeNull();
    });

    it("allows zero-cost platform BYOK when an incomplete subscription has expired", async () => {
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "incomplete_expired",
        creditsUsed: 0,
        creditQuota: 0,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "org",
        executionPlane: "platform",
        timeoutSeconds: 900,
      });
      expect(result).toBeNull();
    });

    it("rejects a platform system run with 402 when the credit quota is zero", async () => {
      // Acceptance 2: same account, but a platform-supplied credential quotes a
      // positive model component.
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "active",
        creditsUsed: 0,
        creditQuota: 0,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 900,
      });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(402);
      expect(result!.code).toBe("quota_exceeded");
    });
  });

  describe("self-funded short-circuit", () => {
    it("allows a remote BYOK run for an org with no billing account at all", async () => {
      // Acceptance 6: the org supplies both the credential and the host, so the
      // hook returns before any billing DB read. Asserting the table is still
      // empty afterwards proves no account row was required (or created).
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 2,
        credentialSource: "org",
        executionPlane: "remote",
        timeoutSeconds: 3600,
      });
      expect(result).toBeNull();

      const rows = await getEeDb()
        .select({ orgId: billingAccounts.orgId })
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));
      expect(rows).toHaveLength(0);
    });

    it("allows a remote run with an undeterminable credential source", async () => {
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: null,
        executionPlane: "remote",
        timeoutSeconds: null,
      });
      expect(result).toBeNull();
    });

    it("allows a remote BYOK run even on a blocked subscription", async () => {
      // The short-circuit precedes the entitlement gate by design: a blocked
      // account cannot consume what the platform does not fund.
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "canceled",
        creditsUsed: 0,
        creditQuota: 5000,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "org",
        executionPlane: "remote",
        timeoutSeconds: 1800,
      });
      expect(result).toBeNull();
    });
  });

  describe("entitlement is independent of the balance", () => {
    it("rejects a platform BYOK run (quote 0) on a blocked subscription", async () => {
      // Acceptance 8: the run occupies platform compute, so a suspended account
      // is blocked regardless of the arithmetic quote.
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "unpaid",
        creditsUsed: 0,
        creditQuota: 5000,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "org",
        executionPlane: "platform",
        timeoutSeconds: 600,
      });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(402);
      expect(result!.code).toBe("subscription_blocked");
    });

    it("reports subscription_blocked for entitlement and quota_exceeded for balance — the two gates are independent and distinguishable", async () => {
      // THE acceptance criterion: the entitlement gate and the balance gate are
      // independent, and a caller must be able to tell which one fired —
      // "fix your subscription" is a different remedy from "top up".
      const blockedOrg = "00000000-0000-4000-a000-000000000901";
      const brokeOrg = "00000000-0000-4000-a000-000000000902";

      // Blocked subscription, credits to spare → entitlement.
      await seedBillingAccount({
        orgId: blockedOrg,
        subscriptionStatus: "canceled",
        creditsUsed: 0,
        creditQuota: 5000,
      });
      // Healthy subscription, no credits left → balance.
      await seedBillingAccount({
        orgId: brokeOrg,
        subscriptionStatus: "active",
        creditsUsed: 5000,
        creditQuota: 5000,
      });

      const blocked = await beforeUsage({
        orgId: blockedOrg,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 600,
      });
      const broke = await beforeUsage({
        orgId: brokeOrg,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 600,
      });

      expect(blocked!.code).toBe("subscription_blocked");
      expect(broke!.code).toBe("quota_exceeded");
      expect(blocked!.code).not.toBe(broke!.code);
      // Both remain 402 — only the code narrows the cause.
      expect(blocked!.status).toBe(402);
      expect(broke!.status).toBe(402);
    });

    it("rejects a platform BYOK chat turn (quote 0) on a blocked subscription", async () => {
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "paused",
        creditsUsed: 0,
        creditQuota: 5000,
      });
      const result = await beforeUsage({
        orgId,
        context: "chat",
        sessionId: "sess-5",
        credentialSource: "org",
        executionPlane: "platform",
      });
      expect(result).not.toBeNull();
      expect(result!.code).toBe("subscription_blocked");
      expect(result!.status).toBe(402);
    });
  });

  describe("system-proxy seam (null timeout)", () => {
    it("admits a system proxy call for a running platform run without double-counting compute", async () => {
      // `timeoutSeconds: null` means "this seam does not own the run's compute"
      // — only the model component is quoted here.
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "active",
        creditsUsed: 0,
        creditQuota: 5000,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: null,
      });
      expect(result).toBeNull();
    });

    it("still gates the model component of a proxy-seam admission", async () => {
      await seedBillingAccount({
        orgId,
        subscriptionStatus: "active",
        creditsUsed: 5000 - ESTIMATED_MODEL_CREDITS_PER_RUN + 1,
        creditQuota: 5000,
      });
      const result = await beforeUsage({
        orgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "remote",
        timeoutSeconds: null,
      });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(402);
    });
  });

  describe("fail-CLOSED on an unexpected error", () => {
    // This hook is the only thing between an unreachable EE DB and unmetered
    // usage: it must BLOCK, not admit. Nothing pinned that before — replacing
    // its `return { status: 500 }` with `return null`, i.e. admitting unbilled
    // usage whenever the billing DB hiccups, broke no test.
    //
    // Driven with a value the `org_id` uuid column cannot parse, so the failure
    // is a real database error raised beneath `checkQuota`, not a mock. The
    // facts are well-formed AND platform-funded on purpose: a self-funded
    // operation short-circuits before the quota read, and unrecognized facts
    // are refused before it — neither would reach the failure this pins.
    const malformedOrgId = "not-a-uuid";

    it("returns a 500 rejection (never null) when the quota read fails for a run", async () => {
      const result = await beforeUsage({
        orgId: malformedOrgId,
        context: "run",
        packageId: "@x/agent",
        runningCount: 1,
        credentialSource: "system",
        executionPlane: "platform",
        timeoutSeconds: 600,
      });

      expect(result).not.toBeNull();
      expect(result!.status).toBe(500);
      expect(result!.code).toBe("unexpected");
    });

    it("blocks a chat turn the same way", async () => {
      const result = await beforeUsage({
        orgId: malformedOrgId,
        context: "chat",
        sessionId: "sess-fail-closed",
        credentialSource: "system",
        executionPlane: "platform",
      });

      expect(result).not.toBeNull();
      expect(result!.status).toBe(500);
      expect(result!.code).toBe("unexpected");
    });
  });
});
