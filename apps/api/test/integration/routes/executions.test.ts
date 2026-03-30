import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../helpers/auth.ts";
import { seedFlow, seedExecution, seedExecutionLog } from "../../helpers/seed.ts";

const app = getTestApp();

describe("Executions API", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "execorg" });
  });


  // ─── POST /api/flows/:scope/:name/run — input validation ──

  describe("POST /api/flows/:scope/:name/run — input validation", () => {
    const inputSchema = {
      type: "object",
      properties: {
        email: { type: "string", description: "User email" },
        count: { type: "number", description: "Optional count" },
      },
      required: ["email"],
    };

    async function seedFlowWithInput() {
      return seedFlow({
        id: "@execorg/input-flow",
        orgId: ctx.orgId,
        createdBy: ctx.user.id,
        draftManifest: {
          name: "@execorg/input-flow",
          version: "0.1.0",
          type: "flow",
          description: "Flow with required input",
          input: { schema: inputSchema },
        },
        draftContent: "Process the email: {{email}}",
      });
    }

    it("returns 400 when required input field is missing", async () => {
      await seedFlowWithInput();

      const res = await app.request("/api/flows/@execorg/input-flow/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { count: 5 } }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.detail).toContain("email");
    });

    it("returns 400 when input is omitted entirely and schema has required fields", async () => {
      await seedFlowWithInput();

      const res = await app.request("/api/flows/@execorg/input-flow/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is empty string", async () => {
      await seedFlowWithInput();

      const res = await app.request("/api/flows/@execorg/input-flow/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: "" } }),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when required field is null", async () => {
      await seedFlowWithInput();

      const res = await app.request("/api/flows/@execorg/input-flow/run", {
        method: "POST",
        headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
        body: JSON.stringify({ input: { email: null } }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ─── GET /api/flows/:scope/:name/executions ────────────────

  describe("GET /api/flows/:scope/:name/executions", () => {
    it("returns empty array when no executions exist", async () => {
      await seedFlow({ id: "@execorg/my-flow", orgId: ctx.orgId, createdBy: ctx.user.id });

      const res = await app.request("/api/flows/@execorg/my-flow/executions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.executions).toBeArray();
      expect(body.executions).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    it("returns executions for a flow", async () => {
      await seedFlow({ id: "@execorg/my-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/my-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request("/api/flows/@execorg/my-flow/executions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.executions.length).toBeGreaterThanOrEqual(1);
      const found = body.executions.find((e: { id: string }) => e.id === exec.id);
      expect(found).toBeDefined();
    });

    it("respects org isolation", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({ id: "@otherorg/secret-flow", orgId: otherCtx.orgId });
      await seedExecution({
        packageId: "@otherorg/secret-flow",
        orgId: otherCtx.orgId,
        userId: otherCtx.user.id,
        status: "success",
      });

      // The flow does not belong to testorg, so requireFlow() should 404
      const res = await app.request("/api/flows/@otherorg/secret-flow/executions", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows/@execorg/my-flow/executions");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/executions/:id ───────────────────────────────

  describe("GET /api/executions/:id", () => {
    it("returns execution detail", async () => {
      await seedFlow({ id: "@execorg/detail-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/detail-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/executions/${exec.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(exec.id);
      expect(body.status).toBe("success");
    });

    it("returns 404 for non-existent execution", async () => {
      const res = await app.request("/api/executions/exec_nonexistent", {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 404 for execution from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({ id: "@otherorg/other-flow", orgId: otherCtx.orgId });
      const exec = await seedExecution({
        packageId: "@otherorg/other-flow",
        orgId: otherCtx.orgId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/executions/${exec.id}`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/executions/exec_anything");
      expect(res.status).toBe(401);
    });
  });

  // ─── GET /api/executions/:id/logs ──────────────────────────

  describe("GET /api/executions/:id/logs", () => {
    it("returns execution logs", async () => {
      await seedFlow({ id: "@execorg/log-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/log-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedExecutionLog({
        executionId: exec.id,
        orgId: ctx.orgId,
        message: "Step 1 completed",
        level: "info",
      });
      await seedExecutionLog({
        executionId: exec.id,
        orgId: ctx.orgId,
        message: "Step 2 completed",
        level: "info",
      });

      const res = await app.request(`/api/executions/${exec.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toBeArray();
      expect(body.length).toBeGreaterThanOrEqual(2);
    });

    it("returns empty array when no logs exist", async () => {
      await seedFlow({ id: "@execorg/nolog-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/nolog-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "pending",
      });

      const res = await app.request(`/api/executions/${exec.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toBeArray();
      expect(body).toHaveLength(0);
    });

    it("returns 404 for execution from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({ id: "@otherorg/log-flow", orgId: otherCtx.orgId });
      const exec = await seedExecution({
        packageId: "@otherorg/log-flow",
        orgId: otherCtx.orgId,
        userId: otherCtx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/executions/${exec.id}/logs`, {
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/executions/exec_anything/logs");
      expect(res.status).toBe(401);
    });
  });

  // ─── POST /api/executions/:id/cancel ───────────────────────

  describe("POST /api/executions/:id/cancel", () => {
    it("cancels a running execution", async () => {
      await seedFlow({ id: "@execorg/cancel-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/cancel-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "running",
      });

      const res = await app.request(`/api/executions/${exec.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it("cancels a pending execution", async () => {
      await seedFlow({ id: "@execorg/cancel-pending", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/cancel-pending",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "pending",
      });

      const res = await app.request(`/api/executions/${exec.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.ok).toBe(true);
    });

    it("returns 409 for non-running execution", async () => {
      await seedFlow({ id: "@execorg/done-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      const exec = await seedExecution({
        packageId: "@execorg/done-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });

      const res = await app.request(`/api/executions/${exec.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(409);
    });

    it("returns 404 for non-existent execution", async () => {
      const res = await app.request("/api/executions/exec_nonexistent/cancel", {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(404);
    });

    it("returns 403 for execution from another org", async () => {
      const otherCtx = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({ id: "@otherorg/cancel-flow", orgId: otherCtx.orgId });
      const exec = await seedExecution({
        packageId: "@otherorg/cancel-flow",
        orgId: otherCtx.orgId,
        userId: otherCtx.user.id,
        status: "running",
      });

      const res = await app.request(`/api/executions/${exec.id}/cancel`, {
        method: "POST",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/executions/exec_anything/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  // ─── DELETE /api/flows/:scope/:name/executions ─────────────

  describe("DELETE /api/flows/:scope/:name/executions", () => {
    it("deletes all executions for a flow (admin)", async () => {
      await seedFlow({ id: "@execorg/del-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedExecution({
        packageId: "@execorg/del-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      await seedExecution({
        packageId: "@execorg/del-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "failed",
      });

      const res = await app.request("/api/flows/@execorg/del-flow/executions", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.deleted).toBeGreaterThanOrEqual(2);
    });

    it("returns 409 when running executions exist", async () => {
      await seedFlow({ id: "@execorg/running-flow", orgId: ctx.orgId, createdBy: ctx.user.id });
      await seedExecution({
        packageId: "@execorg/running-flow",
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "running",
      });

      const res = await app.request("/api/flows/@execorg/running-flow/executions", {
        method: "DELETE",
        headers: authHeaders(ctx),
      });

      expect(res.status).toBe(409);
    });

    it("returns 401 without authentication", async () => {
      const res = await app.request("/api/flows/@execorg/any-flow/executions", {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });
});
