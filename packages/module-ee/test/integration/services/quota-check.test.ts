// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { truncateEeTables } from "../../helpers/db.ts";
import { seedBillingAccount } from "../../helpers/seed.ts";
import { checkQuota, QuotaExceededError } from "../../../src/billing/quota-check.ts";
import type { UsageQuote } from "../../../src/billing/usage-quote.ts";
import { ESTIMATED_MODEL_CREDITS_PER_RUN } from "../../../src/config.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

/**
 * Build a quote worth `total` credits. `checkQuota` only reads `totalCredits`;
 * the split is carried for readability and to keep the shape honest.
 */
function quoteOf(total: number): UsageQuote {
  return { modelCredits: total, computeCredits: 0, totalCredits: total };
}

const ZERO_QUOTE = quoteOf(0);

describe("checkQuota", () => {
  beforeEach(async () => {
    await truncateEeTables();
  });

  const orgId = "00000000-0000-4000-a000-000000000001";

  it("passes when active subscription has credits remaining", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 1000,
      creditQuota: 5000,
    });

    await expect(checkQuota(orgId, ZERO_QUOTE)).resolves.toBeUndefined();
  });

  it("passes for free tier (null status) with credits remaining", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: null,
      creditsUsed: 0,
      creditQuota: 5000,
    });

    await expect(checkQuota(orgId, ZERO_QUOTE)).resolves.toBeUndefined();
  });

  it("throws QuotaExceededError with reason 'budget' when credit quota is exhausted", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 5000,
      creditQuota: 5000,
    });

    try {
      await checkQuota(orgId, quoteOf(1));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.reason).toBe("budget");
      expect(qe.orgId).toBe(orgId);
      expect(qe.code).toBe("QUOTA_EXCEEDED");
    }
  });

  it("throws QuotaExceededError with reason 'no_account' when org has no account and the quote is positive", async () => {
    const unknownOrg = "00000000-0000-4000-a000-000000000099";

    try {
      await checkQuota(unknownOrg, quoteOf(1));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.reason).toBe("no_account");
      expect(qe.orgId).toBe(unknownOrg);
    }
  });

  it("passes when org has no account and the quote is zero (nothing to owe)", async () => {
    // Deliberate asymmetry: a missing account cannot owe anything, so a
    // zero-cost operation must not be rejected for lacking an account row —
    // orgs predating the billing module legitimately have none.
    const unknownOrg = "00000000-0000-4000-a000-000000000098";

    await expect(checkQuota(unknownOrg, ZERO_QUOTE)).resolves.toBeUndefined();
  });

  it("throws when creditQuota is 0 and the quote is positive", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: null,
      creditsUsed: 0,
      creditQuota: 0,
    });

    try {
      await checkQuota(orgId, quoteOf(1));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect((err as QuotaExceededError).reason).toBe("budget");
    }
  });

  describe("hard-blocked statuses", () => {
    const blockedStatuses = ["unpaid", "paused"];

    for (const status of blockedStatuses) {
      it(`throws with reason 'status' for ${status} subscription`, async () => {
        await seedBillingAccount({
          orgId,
          subscriptionStatus: status,
          creditsUsed: 0,
          creditQuota: 5000,
        });

        try {
          await checkQuota(orgId, ZERO_QUOTE);
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(QuotaExceededError);
          expect((err as QuotaExceededError).reason).toBe("status");
        }
      });
    }
  });

  describe("ended paid entitlements", () => {
    const endedStatuses = ["canceled", "incomplete_expired"];

    for (const status of endedStatuses) {
      it(`allows a zero quote for ${status}`, async () => {
        await seedBillingAccount({
          orgId,
          subscriptionStatus: status,
          creditsUsed: 0,
          creditQuota: 0,
        });

        await expect(checkQuota(orgId, ZERO_QUOTE)).resolves.toBeUndefined();
      });

      it(`rejects a positive quote with reason 'status' for ${status}`, async () => {
        await seedBillingAccount({
          orgId,
          subscriptionStatus: status,
          creditsUsed: 0,
          creditQuota: 5000,
        });

        try {
          await checkQuota(orgId, quoteOf(1));
          expect.unreachable("should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(QuotaExceededError);
          expect((err as QuotaExceededError).reason).toBe("status");
        }
      });
    }
  });

  it("passes for past_due subscription (grace period)", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "past_due",
      creditsUsed: 0,
      creditQuota: 5000,
    });

    await expect(checkQuota(orgId, ZERO_QUOTE)).resolves.toBeUndefined();
  });

  it("passes for trialing subscription", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "trialing",
      creditsUsed: 0,
      creditQuota: 5000,
    });

    await expect(checkQuota(orgId, ZERO_QUOTE)).resolves.toBeUndefined();
  });

  it("throws when the in-flight credit estimate pushes over the quota", async () => {
    // creditsUsed=4801, quota=5000 → remaining 199. One run's model estimate
    // (200) does not fit: 200 > 199 → budget.
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 4801,
      creditQuota: 5000,
    });

    await expect(checkQuota(orgId, ZERO_QUOTE)).resolves.toBeUndefined();

    try {
      await checkQuota(orgId, quoteOf(ESTIMATED_MODEL_CREDITS_PER_RUN));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect((err as QuotaExceededError).reason).toBe("budget");
    }
  });

  it("accounts for the estimate of multiple in-flight runs", async () => {
    // creditsUsed=0, quota=5000 → remaining 5000. 25 runs quote exactly 5000
    // (affordable); 26 runs quote 5200 > 5000 → budget.
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 0,
      creditQuota: 5000,
    });

    await expect(
      checkQuota(orgId, quoteOf(25 * ESTIMATED_MODEL_CREDITS_PER_RUN)),
    ).resolves.toBeUndefined();

    try {
      await checkQuota(orgId, quoteOf(26 * ESTIMATED_MODEL_CREDITS_PER_RUN));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      expect((err as QuotaExceededError).reason).toBe("budget");
    }
  });

  it("delegates the balance rule to isAffordable against the account it read", async () => {
    // The pure boundary arithmetic is covered in test/unit/quota-affordability;
    // what needs the DB is that `checkQuota` feeds the predicate the row it just
    // read. remaining = 200 → 200 fits, 201 does not.
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "active",
      creditsUsed: 4800,
      creditQuota: 5000,
    });

    await expect(checkQuota(orgId, quoteOf(200))).resolves.toBeUndefined();

    try {
      await checkQuota(orgId, quoteOf(201));
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as QuotaExceededError).reason).toBe("budget");
    }
  });

  it("QuotaExceededError has code, orgId, and reason fields", async () => {
    await seedBillingAccount({
      orgId,
      subscriptionStatus: "unpaid",
      creditsUsed: 0,
      creditQuota: 5000,
    });

    try {
      await checkQuota(orgId, ZERO_QUOTE);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qe = err as QuotaExceededError;
      expect(qe.code).toBe("QUOTA_EXCEEDED");
      expect(qe.orgId).toBe(orgId);
      expect(qe.reason).toBe("status");
      expect(qe.name).toBe("QuotaExceededError");
      expect(qe.message).toContain(orgId);
    }
  });
});
