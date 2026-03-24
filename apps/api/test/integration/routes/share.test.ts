import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedShareLink } from "../../helpers/seed.ts";
import { shareLinkUsages } from "@appstrate/db/schema";
import { eq } from "drizzle-orm";

const app = getTestApp();

describe("Share API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /share/:token/flow", () => {
    it("returns flow info for a valid share link", async () => {
      const flow = await seedFlow({
        id: "@myorg/shared-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/shared-flow",
          version: "0.1.0",
          type: "flow",
          description: "A shared flow",
          displayName: "Shared Flow",
        },
      });

      const shareLink = await seedShareLink({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request(`/share/${shareLink.token}/flow`);

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.description).toBe("A shared flow");
      expect(body.usageCount).toBe(0);
      expect(body.exhausted).toBe(false);
    });

    it("returns exhausted: true for a fully-used link", async () => {
      const flow = await seedFlow({
        id: "@myorg/used-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const shareLink = await seedShareLink({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        maxUses: 1,
        usageCount: 1,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });

      // Create a usage record so there's an execution to find
      await db.insert(shareLinkUsages).values({
        shareLinkId: shareLink.id,
        executionId: null,
      });

      const res = await app.request(`/share/${shareLink.token}/flow`);

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.usageCount).toBe(1);
      expect(body.exhausted).toBe(true);
    });

    it("returns 410 for an expired link", async () => {
      const flow = await seedFlow({
        id: "@myorg/expired-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const shareLink = await seedShareLink({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        expiresAt: new Date(Date.now() - 1000 * 60), // expired 1 minute ago
      });

      const res = await app.request(`/share/${shareLink.token}/flow`);

      expect(res.status).toBe(410);
    });

    it("returns 410 for an inactive link", async () => {
      const flow = await seedFlow({
        id: "@myorg/inactive-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const shareLink = await seedShareLink({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        isActive: false,
      });

      const res = await app.request(`/share/${shareLink.token}/flow`);

      expect(res.status).toBe(410);
    });

    it("returns 410 for an invalid token", async () => {
      const res = await app.request("/share/nonexistent-token-12345/flow");

      expect(res.status).toBe(410);
    });
  });
});
