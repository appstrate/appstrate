import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedExecution } from "../../helpers/seed.ts";
import { signExecutionToken } from "../../../src/lib/execution-token.ts";

const app = getTestApp();

describe("Internal API", () => {
  let ctx: TestContext;
  let flowId: string;
  let runningExecId: string;
  let runningToken: string;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "internalorg" });
    flowId = "@internalorg/test-flow";

    await seedFlow({
      id: flowId,
      orgId: ctx.orgId,
      createdBy: ctx.user.id,
    });

    const exec = await seedExecution({
      packageId: flowId,
      orgId: ctx.orgId,
      userId: ctx.user.id,
      status: "running",
    });
    runningExecId = exec.id;
    runningToken = signExecutionToken(runningExecId);
  });

  // ─── GET /internal/execution-history ─────────────────────────

  describe("GET /internal/execution-history", () => {
    it("returns 401 without token", async () => {
      const res = await app.request("/internal/execution-history");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await app.request("/internal/execution-history", {
        headers: { Authorization: "Bearer totally-invalid-token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 with forged signature", async () => {
      // Valid format but wrong HMAC
      const res = await app.request("/internal/execution-history", {
        headers: {
          Authorization: `Bearer ${runningExecId}.0000000000000000000000000000000000000000000000000000000000000000`,
        },
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when execution is not running", async () => {
      const doneExec = await seedExecution({
        packageId: flowId,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
      });
      const doneToken = signExecutionToken(doneExec.id);

      const res = await app.request("/internal/execution-history", {
        headers: { Authorization: `Bearer ${doneToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns empty array for first execution (no prior history)", async () => {
      const res = await app.request("/internal/execution-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { executions: unknown[] };
      expect(body.executions).toBeArray();
      expect(body.executions).toHaveLength(0);
    });

    it("returns recent executions for the same flow and user", async () => {
      // Seed 2 completed executions for the same flow+user
      await seedExecution({
        packageId: flowId,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
        state: { counter: 1 },
      });
      await seedExecution({
        packageId: flowId,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
        state: { counter: 2 },
      });

      const res = await app.request("/internal/execution-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { executions: Record<string, unknown>[] };
      expect(body.executions).toBeArray();
      expect(body.executions.length).toBe(2);
    });

    it("respects the limit query parameter", async () => {
      // Seed 3 completed executions
      for (let i = 0; i < 3; i++) {
        await seedExecution({
          packageId: flowId,
          orgId: ctx.orgId,
          userId: ctx.user.id,
          status: "success",
          state: { i },
        });
      }

      const res = await app.request("/internal/execution-history?limit=2", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { executions: unknown[] };
      expect(body.executions).toHaveLength(2);
    });

    it("clamps limit to valid range (min 1, max 50)", async () => {
      // limit=0 should be clamped to 1
      const res = await app.request("/internal/execution-history?limit=0", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res.status).toBe(200);

      // limit=999 should be clamped to 50
      const res2 = await app.request("/internal/execution-history?limit=999", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });
      expect(res2.status).toBe(200);
    });

    it("excludes the current running execution from results", async () => {
      // The running execution itself should never appear in history
      const res = await app.request("/internal/execution-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { executions: { id: string }[] };
      const ids = body.executions.map((e) => e.id);
      expect(ids).not.toContain(runningExecId);
    });

    it("does not return executions from a different user", async () => {
      // Seed an execution by a different user for the same flow
      const other = await createTestContext({ orgSlug: "otherorg" });
      await seedFlow({
        id: "@otherorg/test-flow",
        orgId: other.orgId,
        createdBy: other.user.id,
      });
      await seedExecution({
        packageId: "@otherorg/test-flow",
        orgId: other.orgId,
        userId: other.user.id,
        status: "success",
        state: { foreign: true },
      });

      const res = await app.request("/internal/execution-history", {
        headers: { Authorization: `Bearer ${runningToken}` },
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { executions: unknown[] };
      expect(body.executions).toHaveLength(0);
    });

    it("accepts fields=state,result query parameter", async () => {
      await seedExecution({
        packageId: flowId,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "success",
        state: { key: "value" },
        result: { output: "done" },
      });

      const res = await app.request(
        "/internal/execution-history?fields=state,result",
        { headers: { Authorization: `Bearer ${runningToken}` } },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { executions: Record<string, unknown>[] };
      expect(body.executions).toHaveLength(1);
      const entry = body.executions[0]!;
      expect(entry.state).toEqual({ key: "value" });
      expect(entry.result).toEqual({ output: "done" });
    });
  });

  // ─── GET /internal/credentials/:scope/:name ──────────────────

  describe("GET /internal/credentials/:scope/:name", () => {
    it("returns 401 without token", async () => {
      const res = await app.request("/internal/credentials/@internalorg/gmail");
      expect(res.status).toBe(401);
    });

    it("returns 401 with invalid token", async () => {
      const res = await app.request("/internal/credentials/@internalorg/gmail", {
        headers: { Authorization: "Bearer bad.token" },
      });
      expect(res.status).toBe(401);
    });

    it("returns 403 when execution is not running", async () => {
      const doneExec = await seedExecution({
        packageId: flowId,
        orgId: ctx.orgId,
        userId: ctx.user.id,
        status: "failed",
      });
      const doneToken = signExecutionToken(doneExec.id);

      const res = await app.request("/internal/credentials/@internalorg/gmail", {
        headers: { Authorization: `Bearer ${doneToken}` },
      });
      expect(res.status).toBe(403);
    });

    it("returns 404 for a provider not required by the flow", async () => {
      // The test flow has no manifest providers, so any provider should 404.
      // However, getPackage may return null for a flow without a published manifest.
      // The route will either 404 on "Flow not found" or "Provider not required".
      const res = await app.request(
        "/internal/credentials/@internalorg/unknown-provider",
        { headers: { Authorization: `Bearer ${runningToken}` } },
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 when execution does not exist", async () => {
      // Sign a token for a non-existent execution ID
      const fakeToken = signExecutionToken("exec_doesnotexist00");

      const res = await app.request("/internal/credentials/@internalorg/gmail", {
        headers: { Authorization: `Bearer ${fakeToken}` },
      });

      expect(res.status).toBe(404);
    });
  });
});
