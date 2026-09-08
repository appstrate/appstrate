// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { describe, expect, it, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { truncateEeTables, getEeDb } from "../../helpers/db.ts";
import {
  seedBillingAccount,
  seedBillingManager,
  seedFreeTierClaim,
  seedUsageRecord,
} from "../../helpers/seed.ts";
import { resetStripeMock, requests } from "../../helpers/stripe.ts";
import { onOrgCreate, onOrgDelete } from "../../../src/onboarding/post-signup.ts";
import { listBillingManagers } from "../../../src/billing/managers.ts";
import { billingAccounts, freeTierClaims, orgUsageRecords } from "../../../drizzle/schema.ts";
import { useEeTestSeams } from "../../helpers/setup.ts";

useEeTestSeams();

// EE owns its DB now — no org stub/FK to seed before onOrgCreate.
async function testOrgCreated(orgId: string, email: string): Promise<void> {
  return onOrgCreate(orgId, email);
}

describe("post-signup", () => {
  const orgId = "00000000-0000-4000-a000-000000000050";

  beforeEach(async () => {
    await truncateEeTables();
    resetStripeMock();
  });

  describe("onOrgCreate", () => {
    it("creates a billing account with 5000 credits quota for a new email", async () => {
      await testOrgCreated(orgId, "alice@example.com");

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account).toBeDefined();
      expect(account!.planId).toBe("free");
      expect(account!.creditsUsed).toBe(0);
      expect(account!.creditQuota).toBe(5000);
    });

    it("seeds the billing contact with the creator's address as typed", async () => {
      // Not `normalizeEmail`'s output: normalization strips plus- and
      // dot-addressing to make the free-tier claim hard to alias, and mailing
      // an invoice to a rewritten address is a different job.
      await testOrgCreated(orgId, "Alice.Smith+billing@gmail.com");

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));

      expect(account!.billingEmail).toBe("Alice.Smith+billing@gmail.com");
      expect(account!.billingCc).toEqual([]);
    });

    it("inserts a free tier claim for new emails", async () => {
      await testOrgCreated(orgId, "bob@example.com");

      const db = getEeDb();
      const [claim] = await db
        .select()
        .from(freeTierClaims)
        .where(eq(freeTierClaims.email, "bob@example.com"));

      expect(claim).toBeDefined();
    });

    it("creates billing account with $0 budget for already-claimed email", async () => {
      await seedFreeTierClaim({ email: "claimed@example.com" });

      const orgId2 = "00000000-0000-4000-a000-000000000051";
      await testOrgCreated(orgId2, "claimed@example.com");

      const db = getEeDb();
      const [account] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId2));

      expect(account).toBeDefined();
      expect(account!.creditQuota).toBe(0);
    });

    it("grants the free tier to exactly one of two concurrent orgs sharing an email", async () => {
      // Race: two org creations for the same email fire concurrently. The claim
      // row is the serialization point — exactly one must win the 5000 grant,
      // the other gets 0. A prior SELECT-then-grant would credit both.
      const orgA = "00000000-0000-4000-a000-0000000000a1";
      const orgB = "00000000-0000-4000-a000-0000000000a2";

      await Promise.all([
        testOrgCreated(orgA, "race@example.com"),
        testOrgCreated(orgB, "race@example.com"),
      ]);

      const db = getEeDb();
      const accounts = await db
        .select({ creditQuota: billingAccounts.creditQuota })
        .from(billingAccounts);

      const quotas = accounts.map((a) => a.creditQuota).sort((x, y) => x - y);
      expect(quotas).toEqual([0, 5000]);
    });

    it("normalizes email to lowercase", async () => {
      await testOrgCreated(orgId, "Alice@Example.COM");

      const db = getEeDb();
      const [claim] = await db
        .select()
        .from(freeTierClaims)
        .where(eq(freeTierClaims.email, "alice@example.com"));

      expect(claim).toBeDefined();
    });

    it("strips Gmail dots for normalization", async () => {
      const orgId1 = "00000000-0000-4000-a000-000000000052";
      const orgId2 = "00000000-0000-4000-a000-000000000053";

      await testOrgCreated(orgId1, "a.l.i.c.e@gmail.com");
      await testOrgCreated(orgId2, "alice@gmail.com");

      const db = getEeDb();
      const [account2] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId2));

      // Second org should get $0 budget since alice@gmail.com was already claimed
      expect(account2!.creditQuota).toBe(0);
    });

    it("strips plus addressing for normalization", async () => {
      const orgId1 = "00000000-0000-4000-a000-000000000054";
      const orgId2 = "00000000-0000-4000-a000-000000000055";

      await testOrgCreated(orgId1, "alice+test@example.com");
      await testOrgCreated(orgId2, "alice+other@example.com");

      const db = getEeDb();
      const [account2] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId2));

      // Second org should get $0 budget due to plus-addressing normalization
      expect(account2!.creditQuota).toBe(0);
    });

    it("normalizes googlemail.com to gmail.com", async () => {
      const orgId1 = "00000000-0000-4000-a000-000000000056";
      const orgId2 = "00000000-0000-4000-a000-000000000057";

      await testOrgCreated(orgId1, "alice@googlemail.com");
      await testOrgCreated(orgId2, "alice@gmail.com");

      const db = getEeDb();
      const [account2] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId2));

      // Both normalize to alice@gmail.com
      expect(account2!.creditQuota).toBe(0);
    });

    it("combines Gmail dot stripping and googlemail normalization", async () => {
      const orgId1 = "00000000-0000-4000-a000-000000000058";
      const orgId2 = "00000000-0000-4000-a000-000000000059";

      await testOrgCreated(orgId1, "a.l.i.c.e+tag@googlemail.com");
      await testOrgCreated(orgId2, "alice@gmail.com");

      const db = getEeDb();
      const [account2] = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId2));

      expect(account2!.creditQuota).toBe(0);
    });
  });

  describe("onOrgDelete", () => {
    const orgId = "00000000-0000-4000-a000-000000000060";

    it("cancels Stripe subscription when one exists", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: "cus_del_001",
        stripeSubscriptionId: "sub_del_001",
        subscriptionStatus: "active",
      });

      await onOrgDelete(orgId);

      const cancelRequests = requests.filter(
        (r) => r.method === "DELETE" && r.path === "/v1/subscriptions/sub_del_001",
      );
      expect(cancelRequests).toHaveLength(1);
    });

    it("does not call Stripe when no subscription exists", async () => {
      await seedBillingAccount({
        orgId,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
      });

      await onOrgDelete(orgId);

      const cancelRequests = requests.filter(
        (r) => r.method === "DELETE" && r.path.startsWith("/v1/subscriptions/"),
      );
      expect(cancelRequests).toHaveLength(0);
    });

    it("does not throw when org has no billing account", async () => {
      const unknownOrg = "00000000-0000-4000-a000-000000000099";

      // Should not throw
      await expect(onOrgDelete(unknownOrg)).resolves.toBeUndefined();
    });

    it("deletes all of the org's EE-owned rows (no FK cascade exists)", async () => {
      // EE runs its own DB — onOrgDelete is the ONLY thing that cleans up
      // an org's rows. Seed every org-keyed EE table, then assert empty.
      await seedBillingAccount({ orgId, creditsUsed: 100, creditQuota: 5000 });
      await seedUsageRecord({ orgId, contextId: "run-del-001", costCredits: 100 });
      await seedBillingManager({ orgId, userId: "user-finance" });

      await onOrgDelete(orgId);

      const db = getEeDb();
      const accounts = await db
        .select()
        .from(billingAccounts)
        .where(eq(billingAccounts.orgId, orgId));
      const usage = await db.select().from(orgUsageRecords).where(eq(orgUsageRecords.orgId, orgId));
      const managers = await listBillingManagers(orgId);

      expect(accounts).toHaveLength(0);
      expect(usage).toHaveLength(0);
      expect(managers).toHaveLength(0);
    });
  });
});
