import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestUser, createTestOrg } from "../../helpers/auth.ts";
import { seedFlow, seedExecution } from "../../helpers/seed.ts";
import {
  createShareToken,
  getShareToken,
  consumeShareToken,
  linkExecutionToToken,
} from "../../../src/services/share-tokens.ts";
import { shareTokens } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

describe("share-tokens service", () => {
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

  // ── createShareToken ─────────────────────────────────────

  describe("createShareToken", () => {
    it("returns a record with a token string", async () => {
      const actor = { type: "member" as const, id: userId };

      const row = await createShareToken(packageId, actor, orgId);

      expect(row).toBeDefined();
      expect(typeof row!.token).toBe("string");
      expect(row!.token.length).toBe(64); // 32 random bytes → 64 hex chars
      expect(row!.packageId).toBe(packageId);
      expect(row!.orgId).toBe(orgId);
      expect(row!.createdBy).toBe(userId);
      expect(row!.endUserId).toBeNull();
      expect(row!.consumedAt).toBeNull();
    });

    it("uses 7-day default expiry", async () => {
      const actor = { type: "member" as const, id: userId };
      const before = Date.now();

      const row = await createShareToken(packageId, actor, orgId);

      const after = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const expiresMs = new Date(row!.expiresAt!).getTime();

      expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 1000);
      expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs + 1000);
    });

    it("stores optional manifest", async () => {
      const actor = { type: "member" as const, id: userId };
      const manifest = { name: "@testorg/test-flow", version: "1.0.0", type: "flow" };

      const row = await createShareToken(packageId, actor, orgId, undefined, manifest);

      expect(row!.manifest).toEqual(manifest);
    });

    it("stores null manifest when not provided", async () => {
      const actor = { type: "member" as const, id: userId };

      const row = await createShareToken(packageId, actor, orgId);

      expect(row!.manifest).toBeNull();
    });

    it("accepts custom expiry in days", async () => {
      const actor = { type: "member" as const, id: userId };
      const before = Date.now();

      const row = await createShareToken(packageId, actor, orgId, 1);

      const oneDayMs = 1 * 24 * 60 * 60 * 1000;
      const expiresMs = new Date(row!.expiresAt!).getTime();

      expect(expiresMs).toBeGreaterThanOrEqual(before + oneDayMs - 1000);
      expect(expiresMs).toBeLessThanOrEqual(before + oneDayMs + 5000);
    });
  });

  // ── getShareToken ────────────────────────────────────────

  describe("getShareToken", () => {
    it("retrieves an existing token by its token string", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareToken(packageId, actor, orgId);

      const fetched = await getShareToken(created!.token);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created!.id);
      expect(fetched!.token).toBe(created!.token);
      expect(fetched!.packageId).toBe(packageId);
      expect(fetched!.orgId).toBe(orgId);
    });

    it("returns null for a non-existent token", async () => {
      const result = await getShareToken("nonexistent-token-value");

      expect(result).toBeNull();
    });

    it("retrieves token from a different org (share tokens are public by design)", async () => {
      // Create token in org A
      const actor = { type: "member" as const, id: userId };
      const created = await createShareToken(packageId, actor, orgId);

      // Create a second user/org
      const { cookie: _, ...user2 } = await createTestUser({ email: "other@test.com" });
      const { org: org2 } = await createTestOrg(user2.id, { slug: "otherorg" });

      // getShareToken does not filter by org — any caller can look up a token
      const fetched = await getShareToken(created!.token);

      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created!.id);
      expect(fetched!.orgId).toBe(orgId); // Still belongs to org A
      // org2 is unused here; the point is that getShareToken has no org filter
      expect(org2.id).not.toBe(orgId);
    });
  });

  // ── consumeShareToken ────────────────────────────────────

  describe("consumeShareToken", () => {
    it("marks token as consumed and returns token data", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareToken(packageId, actor, orgId);

      const result = await consumeShareToken(created!.token);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(created!.id);
      expect(result!.packageId).toBe(packageId);
      expect(result!.createdBy).toBe(userId);
      expect(result!.orgId).toBe(orgId);

      // Verify consumedAt is set in the database
      const [dbRow] = await db
        .select()
        .from(shareTokens)
        .where(eq(shareTokens.id, created!.id))
        .limit(1);
      expect(dbRow!.consumedAt).not.toBeNull();
    });

    it("returns null for an already-consumed token", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareToken(packageId, actor, orgId);

      // First consumption succeeds
      const first = await consumeShareToken(created!.token);
      expect(first).not.toBeNull();

      // Second consumption returns null
      const second = await consumeShareToken(created!.token);
      expect(second).toBeNull();
    });

    it("returns null for an expired token", async () => {
      const actor = { type: "member" as const, id: userId };
      // Create token that expired 1 hour ago
      const created = await createShareToken(packageId, actor, orgId, 0);

      // Manually set expiresAt to the past
      await db
        .update(shareTokens)
        .set({ expiresAt: new Date(Date.now() - 60 * 60 * 1000) })
        .where(eq(shareTokens.id, created!.id));

      const result = await consumeShareToken(created!.token);

      expect(result).toBeNull();
    });

    it("returns manifest when present", async () => {
      const actor = { type: "member" as const, id: userId };
      const manifest = { name: "@testorg/test-flow", version: "2.0.0", type: "flow" };
      const created = await createShareToken(packageId, actor, orgId, undefined, manifest);

      const result = await consumeShareToken(created!.token);

      expect(result).not.toBeNull();
      expect(result!.manifest).toEqual(manifest);
    });
  });

  // ── linkExecutionToToken ─────────────────────────────────

  describe("linkExecutionToToken", () => {
    it("links an execution to a share token", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareToken(packageId, actor, orgId);

      const execution = await seedExecution({ packageId, orgId });

      await linkExecutionToToken(created!.id, execution.id);

      // Verify the link in the database
      const [dbRow] = await db
        .select()
        .from(shareTokens)
        .where(eq(shareTokens.id, created!.id))
        .limit(1);
      expect(dbRow!.executionId).toBe(execution.id);
    });

    it("overwrites a previous execution link", async () => {
      const actor = { type: "member" as const, id: userId };
      const created = await createShareToken(packageId, actor, orgId);

      const exec1 = await seedExecution({ packageId, orgId });
      const exec2 = await seedExecution({ packageId, orgId });

      await linkExecutionToToken(created!.id, exec1.id);
      await linkExecutionToToken(created!.id, exec2.id);

      const [dbRow] = await db
        .select()
        .from(shareTokens)
        .where(eq(shareTokens.id, created!.id))
        .limit(1);
      expect(dbRow!.executionId).toBe(exec2.id);
    });
  });
});
