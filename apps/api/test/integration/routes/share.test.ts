import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedShareToken } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Share API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /share/:token/flow", () => {
    it("returns flow info for a valid share token", async () => {
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

      const shareToken = await seedShareToken({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const res = await app.request(`/share/${shareToken.token}/flow`);

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.description).toBe("A shared flow");
      expect(body.consumed).toBe(false);
    });

    it("returns 200 with consumed: true for a consumed token", async () => {
      const flow = await seedFlow({
        id: "@myorg/consumed-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const shareToken = await seedShareToken({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });

      const res = await app.request(`/share/${shareToken.token}/flow`);

      // Consumed but not expired → 200 with consumed flag
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.consumed).toBe(true);
    });

    it("returns 410 for an expired token", async () => {
      const flow = await seedFlow({
        id: "@myorg/expired-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });

      const shareToken = await seedShareToken({
        packageId: flow.id,
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        expiresAt: new Date(Date.now() - 1000 * 60), // expired 1 minute ago
      });

      const res = await app.request(`/share/${shareToken.token}/flow`);

      expect(res.status).toBe(410);
    });

    it("returns 410 for an invalid token", async () => {
      const res = await app.request("/share/nonexistent-token-12345/flow");

      expect(res.status).toBe(410);
    });
  });
});
