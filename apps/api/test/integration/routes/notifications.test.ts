import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedExecution } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Notifications API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "notiforg" });
  });


  /**
   * Seed a flow and N executions with notifiedAt set (so they count as unread).
   * Returns the flow and the seeded execution records.
   */
  async function seedNotifiableExecutions(
    count: number,
    flowName = "notif-flow",
  ) {
    const flow = await seedFlow({
      id: `@notiforg/${flowName}`,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    const execs = [];
    for (let i = 0; i < count; i++) {
      const exec = await seedExecution({
        packageId: flow.id,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
        notifiedAt: new Date(),
      });
      execs.push(exec);
    }

    return { flow, executions: execs };
  }

  // ─── GET /api/notifications/unread-count ───────────────────

  describe("GET /api/notifications/unread-count", () => {
    it("returns 0 when no executions exist", async () => {
      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(0);
    });

    it("returns count after seeding notifiable executions", async () => {
      await seedNotifiableExecutions(3);

      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(3);
    });

    it("does not count executions without notifiedAt", async () => {
      await seedFlow({
        id: "@notiforg/silent-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedExecution({
        packageId: "@notiforg/silent-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
        // notifiedAt is null by default — should not be counted
      });

      const res = await app.request("/api/notifications/unread-count", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { count: number };
      expect(body.count).toBe(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/notifications/unread-count");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/notifications/unread-counts-by-flow ──────────

  describe("GET /api/notifications/unread-counts-by-flow", () => {
    it("returns empty counts when no executions exist", async () => {
      const res = await app.request(
        "/api/notifications/unread-counts-by-flow",
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: Record<string, number>;
      };
      expect(body.counts).toEqual({});
    });

    it("returns counts grouped by flow", async () => {
      await seedNotifiableExecutions(2, "flow-a");
      await seedNotifiableExecutions(1, "flow-b");

      const res = await app.request(
        "/api/notifications/unread-counts-by-flow",
        { headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        counts: Record<string, number>;
      };
      expect(body.counts["@notiforg/flow-a"]).toBe(2);
      expect(body.counts["@notiforg/flow-b"]).toBe(1);
    });
  });

  // ─── PUT /api/notifications/read/:executionId ──────────────

  describe("PUT /api/notifications/read/:executionId", () => {
    it("marks a notifiable execution as read", async () => {
      const { executions: execs } = await seedNotifiableExecutions(1);
      const execId = execs[0]!.id;

      const res = await app.request(
        `/api/notifications/read/${execId}`,
        { method: "PUT", headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Verify the count dropped
      const countRes = await app.request(
        "/api/notifications/unread-count",
        { headers: authHeaders(ctx) },
      );
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(0);
    });

    it("returns false for non-existent execution", async () => {
      const res = await app.request(
        "/api/notifications/read/exec_nonexistent",
        { method: "PUT", headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    });

    it("returns false for execution without notifiedAt", async () => {
      await seedFlow({
        id: "@notiforg/no-notif",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      const exec = await seedExecution({
        packageId: "@notiforg/no-notif",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(
        `/api/notifications/read/${exec.id}`,
        { method: "PUT", headers: authHeaders(ctx) },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    });
  });

  // ─── PUT /api/notifications/read-all ───────────────────────

  describe("PUT /api/notifications/read-all", () => {
    it("marks all unread notifications as read", async () => {
      await seedNotifiableExecutions(3);

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number };
      expect(body.updated).toBe(3);

      // Verify the count is now 0
      const countRes = await app.request(
        "/api/notifications/unread-count",
        { headers: authHeaders(ctx) },
      );
      const countBody = (await countRes.json()) as { count: number };
      expect(countBody.count).toBe(0);
    });

    it("returns 0 when no unread notifications exist", async () => {
      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number };
      expect(body.updated).toBe(0);
    });

    it("does not mark already-read notifications again", async () => {
      await seedFlow({
        id: "@notiforg/already-read",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedExecution({
        packageId: "@notiforg/already-read",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
        notifiedAt: new Date(),
        readAt: new Date(),
      });

      const res = await app.request("/api/notifications/read-all", {
        method: "PUT",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { updated: number };
      expect(body.updated).toBe(0);
    });
  });

  // ─── GET /api/executions (user executions across flows) ────

  describe("GET /api/executions (user executions list)", () => {
    it("returns empty list when no executions exist", async () => {
      const res = await app.request("/api/executions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executions: unknown[];
        total: number;
      };
      expect(body.executions).toBeArray();
      expect(body.executions).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns seeded executions with total count", async () => {
      await seedFlow({
        id: "@notiforg/list-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      await seedExecution({
        packageId: "@notiforg/list-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedExecution({
        packageId: "@notiforg/list-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "failed",
      });

      const res = await app.request("/api/executions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executions: { id: string; status: string }[];
        total: number;
      };
      expect(body.executions).toBeArray();
      expect(body.executions).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    it("respects limit parameter", async () => {
      await seedFlow({
        id: "@notiforg/limit-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      for (let i = 0; i < 5; i++) {
        await seedExecution({
          packageId: "@notiforg/limit-flow",
          orgId: ctx.orgId,
          userId: ctx.user.id,
          status: "success",
        });
      }

      const res = await app.request("/api/executions?limit=2", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executions: unknown[];
        total: number;
      };
      expect(body.executions).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("respects offset parameter", async () => {
      await seedFlow({
        id: "@notiforg/offset-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
      });
      for (let i = 0; i < 5; i++) {
        await seedExecution({
          packageId: "@notiforg/offset-flow",
          orgId: ctx.orgId,
          userId: ctx.user.id,
          status: "success",
        });
      }

      const res = await app.request("/api/executions?limit=10&offset=3", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executions: unknown[];
        total: number;
      };
      expect(body.executions).toHaveLength(2);
      expect(body.total).toBe(5);
    });

    it("respects org isolation", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherotherorg" });
      await seedFlow({
        id: "@otherotherorg/secret-flow",
        orgId: otherCtx.orgId,
        createdBy: otherCtx.user.id,
      });
      await seedExecution({
        packageId: "@otherotherorg/secret-flow",
        orgId: otherCtx.orgId,
        userId: otherCtx.user.id,
        status: "success",
      });

      // Request from original context should see 0 executions
      const res = await app.request("/api/executions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        executions: unknown[];
        total: number;
      };
      expect(body.executions).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/executions");
      expect(res.status).toBe(401);
    });
  });
});
