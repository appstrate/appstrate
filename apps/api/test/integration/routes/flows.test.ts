import { describe, it, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedExecution } from "../../helpers/seed.ts";
import { assertDbCount } from "../../helpers/assertions.ts";
import { executions } from "@appstrate/db/schema";

const app = getTestApp();

describe("Flows API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "myorg" });
  });

  describe("GET /api/flows", () => {
    it("returns empty list when no flows exist", async () => {
      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.flows).toBeArray();
      expect(body.flows).toHaveLength(0);
    });

    it("returns flows owned by the org", async () => {
      await seedFlow({ id: "@myorg/test-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.flows.length).toBeGreaterThanOrEqual(1);
      const flow = body.flows.find((f: { id: string }) => f.id === "@myorg/test-flow");
      expect(flow).toBeDefined();
      expect(flow.source).toBe("local");
    });

    it("does not leak flows from other orgs", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({ id: "@otherorg/secret-flow", orgId: otherCtx.orgId });

      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const leaked = body.flows.find((f: { id: string }) => f.id === "@otherorg/secret-flow");
      expect(leaked).toBeUndefined();
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /api/packages/flows/:scope/:name (flow detail)", () => {
    it("returns flow detail", async () => {
      await seedFlow({ id: "@myorg/detail-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/packages/flows/@myorg/detail-flow", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.flow).toBeDefined();
      expect(body.flow.id).toBe("@myorg/detail-flow");
    });

    it("returns 404 for non-existent flow", async () => {
      const res = await app.request("/api/packages/flows/@myorg/nonexistent", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for flow from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg2" });
      await seedFlow({ id: "@otherorg2/private-flow", orgId: otherCtx.orgId });

      const res = await app.request("/api/packages/flows/@otherorg2/private-flow", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });

      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/flows/:scope/:name/config", () => {
    it("updates flow configuration", async () => {
      await seedFlow({
        id: "@myorg/config-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@myorg/config-flow",
          version: "0.1.0",
          type: "flow",
          description: "Test",
          config: {
            schema: { type: "object", properties: { key: { type: "string" } } },
          },
        },
      });

      const res = await app.request("/api/flows/@myorg/config-flow/config", {
        method: "PUT",
        headers: {
          Cookie: ctx.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "value" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.config.key).toBe("value");
      expect(body.validation.valid).toBe(true);
    });
  });

  describe("Multi-tenancy isolation", () => {
    it("isolates execution counts per org", async () => {
      await seedFlow({ id: "@myorg/counted-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedExecution({
        packageId: "@myorg/counted-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedExecution({
        packageId: "@myorg/counted-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "running",
      });

      // Verify DB state directly
      await assertDbCount(
        executions,
        and(eq(executions.packageId, "@myorg/counted-flow"), eq(executions.orgId, ctx.orgId))!,
        2,
      );

      // Verify running count in flow list
      const res = await app.request("/api/flows", {
        headers: { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId },
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      const flow = body.flows.find((f: { id: string }) => f.id === "@myorg/counted-flow");
      expect(flow).toBeDefined();
      expect(flow.runningExecutions).toBe(1);
    });
  });
});
