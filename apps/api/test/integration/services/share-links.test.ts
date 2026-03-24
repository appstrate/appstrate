import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedFlow } from "../../helpers/seed.ts";
import {
  createShareLink,
  getShareLink,
  useShareLink,
  listShareLinks,
  getShareLinkById,
  updateShareLink,
  deleteShareLink,
  listShareLinkUsages,
} from "../../../src/services/share-links.ts";
import { createExecution } from "../../../src/services/state/executions.ts";
import { executions, shareLinks, shareLinkUsages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

describe("share-links service", () => {
  let userId: string;
  let orgId: string;
  let orgSlug: string;
  let packageId: string;

  beforeEach(async () => {
    await truncateAll();
    const { cookie, ...user } = await createTestUser();
    userId = user.id;
    const { org } = await createTestOrg(userId, { slug: "testorg" });
    orgId = org.id;
    orgSlug = org.slug;

    const pkg = await seedFlow({
      orgId,
      id: `@${orgSlug}/test-flow`,
    });
    packageId = pkg.id;
  });

  // ── createShareLink ─────────────────────────────────────

  describe("createShareLink", () => {
    it("returns a record with a token string", async () => {
      const actor = { type: "member" as const, id: userId };

      const row = await createShareLink(packageId, actor, orgId);

      expect(row).toBeDefined();
      expect(typeof row!.token).toBe("string");
      expect(row!.token.length).toBe(64); // 32 random bytes → 64 hex chars
      expect(row!.packageId).toBe(packageId);
      expect(row!.orgId).toBe(orgId);
      expect(row!.createdBy).toBe(userId);
      expect(row!.endUserId).toBeNull();
      expect(row!.usageCount).toBe(0);
      expect(row!.isActive).toBe(true);
      expect(row!.maxUses).toBe(1); // default
    });

    it("uses 7-day default expiry", async () => {
      const actor = { type: "member" as const, id: userId };
      const before = Date.now();

      const row = await createShareLink(packageId, actor, orgId);

      const after = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const expiresMs = new Date(row!.expiresAt!).getTime();

      expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
      expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
    });

    it("stores optional manifest", async () => {
      const actor = { type: "member" as const, id: userId };
      const manifest = { name: "@testorg/test-flow", version: "1.0.0", type: "flow" };

      const row = await createShareLink(packageId, actor, orgId, { manifest });

      expect(row!.manifest).toEqual(manifest);
    });

    it("stores null manifest when not provided", async () => {
      const actor = { type: "member" as const, id: userId };

      const row = await createShareLink(packageId, actor, orgId);

      expect(row!.manifest).toBeNull();
    });

    it("accepts custom expiry in days", async () => {
      const actor = { type: "member" as const, id: userId };
      const before = Date.now();

      const row = await createShareLink(packageId, actor, orgId, { expiresInDays: 1 });

      const oneDayMs = 1 * 24 * 60 * 60 * 1000;
      const expiresMs = new Date(row!.expiresAt!).getTime();

      expect(expiresMs).toBeGreaterThanOrEqual(before + oneDayMs - 1000);
      expect(expiresMs).toBeLessThanOrEqual(before + oneDayMs + 5000);
    });

    it("accepts label and maxUses options", async () => {
      const actor = { type: "member" as const, id: userId };

      const row = await createShareLink(packageId, actor, orgId, {
        label: "Demo link",
        maxUses: 5,
      });

      expect(row!.label).toBe("Demo link");
      expect(row!.maxUses).toBe(5);
    });

    it("accepts null maxUses for unlimited", async () => {
      const actor = { type: "member" as const, id: userId };

      const row = await createShareLink(packageId, actor, orgId, { maxUses: null });

      expect(row!.maxUses).toBeNull();
    });
  });

  // ── getShareLink ────────────────────────────────────────

  describe("getShareLink", () => {
    it("retrieves an existing link by its token string", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const fetched = await getShareLink(created!.token);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created!.id);
      expect(fetched!.token).toBe(created!.token);
      expect(fetched!.packageId).toBe(packageId);
      expect(fetched!.orgId).toBe(orgId);
    });

    it("returns null for a non-existent token", async () => {
      const result = await getShareLink("nonexistent-token-value");

      expect(result).toBeNull();
    });
  });

  // ── useShareLink ───────────────────────────────────────

  describe("useShareLink", () => {
    it("increments usageCount and returns link data", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const result = await useShareLink(created!.token);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(created!.id);
      expect(result!.packageId).toBe(packageId);
      expect(result!.createdBy).toBe(userId);
      expect(result!.orgId).toBe(orgId);

      // Verify usageCount is incremented in the database
      const [dbRow] = await db
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.id, created!.id))
        .limit(1);
      expect(dbRow!.usageCount).toBe(1);
    });

    it("creates a usage record", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      await useShareLink(created!.token, {
        ip: "127.0.0.1",
        userAgent: "TestAgent/1.0",
      });

      const usages = await db
        .select()
        .from(shareLinkUsages)
        .where(eq(shareLinkUsages.shareLinkId, created!.id));
      expect(usages.length).toBe(1);
      expect(usages[0]!.executionId).toBeNull();
      expect(usages[0]!.ip).toBe("127.0.0.1");
      expect(usages[0]!.userAgent).toBe("TestAgent/1.0");
    });

    it("returns null when maxUses is reached", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId, { maxUses: 1 });

      // First use succeeds
      const first = await useShareLink(created!.token);
      expect(first).not.toBeNull();

      // Second use returns null
      const second = await useShareLink(created!.token);
      expect(second).toBeNull();
    });

    it("allows unlimited uses when maxUses is null", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId, { maxUses: null });

      // Multiple uses succeed
      for (let i = 0; i < 5; i++) {
        const result = await useShareLink(created!.token);
        expect(result).not.toBeNull();
      }

      const [dbRow] = await db
        .select()
        .from(shareLinks)
        .where(eq(shareLinks.id, created!.id))
        .limit(1);
      expect(dbRow!.usageCount).toBe(5);
    });

    it("returns null for an expired link", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      // Manually expire the link
      await db
        .update(shareLinks)
        .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(shareLinks.id, created!.id));

      const result = await useShareLink(created!.token);

      expect(result).toBeNull();
    });

    it("returns null for an inactive link", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      // Deactivate the link
      await db
        .update(shareLinks)
        .set({ isActive: false })
        .where(eq(shareLinks.id, created!.id));

      const result = await useShareLink(created!.token);

      expect(result).toBeNull();
    });

    it("returns manifest when present", async () => {
      const actor = { type: "member" as const, id: userId };
      const manifest = { name: "@testorg/test-flow", version: "2.0.0", type: "flow" };
      const created = await createShareLink(packageId, actor, orgId, { manifest });

      const result = await useShareLink(created!.token);

      expect(result).not.toBeNull();
      expect(result!.manifest).toEqual(manifest);
    });
  });

  // ── CRUD ───────────────────────────────────────────────

  describe("listShareLinks", () => {
    it("returns links for a specific flow", async () => {
      const actor = { type: "member" as const, id: userId };
      await createShareLink(packageId, actor, orgId, { label: "Link 1" });
      await createShareLink(packageId, actor, orgId, { label: "Link 2" });

      const links = await listShareLinks(packageId, orgId);

      expect(links.length).toBe(2);
    });

    it("does not return links from other orgs", async () => {
      const actor = { type: "member" as const, id: userId };
      await createShareLink(packageId, actor, orgId);

      const { cookie: _, ...user2 } = await createTestUser({ email: "other@test.com" });
      const { org: org2 } = await createTestOrg(user2.id, { slug: "otherorg" });

      const links = await listShareLinks(packageId, org2.id);
      expect(links.length).toBe(0);
    });
  });

  describe("getShareLinkById", () => {
    it("returns a link by ID and orgId", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const link = await getShareLinkById(created!.id, orgId);

      expect(link).not.toBeNull();
      expect(link!.id).toBe(created!.id);
    });

    it("returns null for wrong orgId", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const { cookie: _, ...user2 } = await createTestUser({ email: "other@test.com" });
      const { org: org2 } = await createTestOrg(user2.id, { slug: "otherorg" });

      const link = await getShareLinkById(created!.id, org2.id);
      expect(link).toBeNull();
    });
  });

  describe("updateShareLink", () => {
    it("updates label and isActive", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const updated = await updateShareLink(created!.id, orgId, {
        label: "Updated",
        isActive: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.label).toBe("Updated");
      expect(updated!.isActive).toBe(false);
    });

    it("updates maxUses", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const updated = await updateShareLink(created!.id, orgId, { maxUses: 10 });

      expect(updated!.maxUses).toBe(10);
    });
  });

  describe("deleteShareLink", () => {
    it("deletes a link and returns true", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId);

      const deleted = await deleteShareLink(created!.id, orgId);

      expect(deleted).toBe(true);
      const remaining = await listShareLinks(packageId, orgId);
      expect(remaining.length).toBe(0);
    });

    it("returns false for non-existent link", async () => {
      const deleted = await deleteShareLink("nonexistent", orgId);
      expect(deleted).toBe(false);
    });
  });

  describe("listShareLinkUsages", () => {
    it("returns usages for a link", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareLink(packageId, actor, orgId, { maxUses: 3 });

      await useShareLink(created!.token);
      await useShareLink(created!.token);

      const usages = await listShareLinkUsages(created!.id);

      expect(usages.length).toBe(2);
    });
  });

  // ── execution ↔ shareLinkId ───────────────────────────────

  describe("execution shareLinkId", () => {
    it("createExecution stores shareLinkId when provided", async () => {
      const actor = { type: "member" as const, id: userId };
      const link = await createShareLink(packageId, actor, orgId);
      const execId = `exec_${crypto.randomUUID()}`;

      await createExecution(
        execId,
        packageId,
        actor,
        orgId,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        link!.id,
      );

      const [row] = await db
        .select()
        .from(executions)
        .where(eq(executions.id, execId))
        .limit(1);
      expect(row!.shareLinkId).toBe(link!.id);
    });

    it("createExecution stores null shareLinkId by default", async () => {
      const actor = { type: "member" as const, id: userId };
      const execId = `exec_${crypto.randomUUID()}`;

      await createExecution(execId, packageId, actor, orgId, null);

      const [row] = await db
        .select()
        .from(executions)
        .where(eq(executions.id, execId))
        .limit(1);
      expect(row!.shareLinkId).toBeNull();
    });
  });
});
