/**
 * Integration tests for SSE realtime routes.
 *
 * Tests the actual HTTP SSE format returned by the three realtime endpoints:
 *   - GET /api/realtime/executions/:id
 *   - GET /api/realtime/flows/:packageId/executions
 *   - GET /api/realtime/executions
 *
 * These tests verify the full pipeline: HTTP request -> auth -> SSE stream -> PG NOTIFY -> event delivery.
 * The underlying subscriber logic is already tested in services/realtime.test.ts.
 */
import { describe, expect, it, beforeEach, beforeAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedFlow, seedExecution } from "../../helpers/seed.ts";
import { sql } from "drizzle-orm";
import { initRealtime } from "../../../src/services/realtime.ts";
import { collectSSEEvents } from "../../helpers/sse.ts";

const app = getTestApp();

/** Fire a PG NOTIFY on a channel with a JSON payload. */
async function pgNotify(channel: string, payload: Record<string, unknown>) {
  await db.execute(sql`SELECT pg_notify(${channel}, ${JSON.stringify(payload)})`);
}

/** Small delay to let PG LISTEN dispatch events to subscribers. */
function wait(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an SSE request to the test app with cookie auth and orgId query param.
 * EventSource cannot send custom headers, so auth uses Cookie + ?orgId= query.
 */
async function sseRequest(
  path: string,
  ctx: TestContext,
  extra?: Record<string, string>,
): Promise<Response> {
  const separator = path.includes("?") ? "&" : "?";
  const url = `${path}${separator}orgId=${ctx.orgId}`;
  return await app.request(url, {
    headers: {
      Cookie: ctx.cookie,
      Accept: "text/event-stream",
      ...extra,
    },
  });
}

describe("realtime SSE routes (integration)", () => {
  let ctx: TestContext;
  let flowPkg: Awaited<ReturnType<typeof seedFlow>>;
  let execution: Awaited<ReturnType<typeof seedExecution>>;

  beforeAll(async () => {
    await initRealtime();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    flowPkg = await seedFlow({ orgId: ctx.orgId });
    execution = await seedExecution({ packageId: flowPkg.id, orgId: ctx.orgId });
  });

  // ── GET /api/realtime/executions/:id ────────────────────────

  describe("GET /api/realtime/executions/:id", () => {
    it("returns SSE content-type header", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}`, ctx);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/event-stream");
      // Cancel stream to clean up
      await res.body?.cancel();
    });

    it("receives execution_update events in SSE format", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}`, ctx);
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      // Fire PG NOTIFY after a short delay to ensure subscriber is registered
      await wait();
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "running",
        package_id: flowPkg.id,
      });

      // Collect: first event should be ping (from keep-alive), then our execution_update
      // But ping has 30s delay, so the execution_update should arrive first
      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("execution_update");

      const data = JSON.parse(events[0]!.data);
      expect(data.id).toBe(execution.id);
      expect(data.status).toBe("running");
      expect(data.orgId).toBe(ctx.orgId);
      expect(data.packageId).toBe(flowPkg.id);
    });

    it("receives ping as first event", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}`, ctx);
      expect(res.body).not.toBeNull();

      // The first event from the SSE stream should be a ping (keep-alive)
      const events = await collectSSEEvents(res.body!, 1, { timeoutMs: 3000 });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("ping");
      expect(events[0]!.data).toBe("");
    });

    it("returns 401 without cookie", async () => {
      const res = await app.request(`/api/realtime/executions/${execution.id}?orgId=${ctx.orgId}`);
      expect(res.status).toBe(401);
    });

    it("returns 401 without orgId query param", async () => {
      const res = await app.request(`/api/realtime/executions/${execution.id}`, {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(401);
    });

    it("filters events by executionId — ignores other executions", async () => {
      const otherExec = await seedExecution({ packageId: flowPkg.id, orgId: ctx.orgId });

      const res = await sseRequest(`/api/realtime/executions/${execution.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();

      // Fire event for a different execution — should be filtered out
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: otherExec.id,
        status: "running",
        package_id: flowPkg.id,
      });
      await wait();

      // Fire event for the target execution — should be received
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "success",
        package_id: flowPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("execution_update");

      const data = JSON.parse(events[0]!.data);
      expect(data.id).toBe(execution.id);
      expect(data.status).toBe("success");
    });

    it("non-verbose mode strips result field from execution_update", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "success",
        package_id: flowPkg.id,
        result: { some: "large-data" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      const data = JSON.parse(events[0]!.data);
      // stripPayload removes "result" for execution_update in non-verbose mode
      expect(data).not.toHaveProperty("result");
      expect(data.id).toBe(execution.id);
    });

    it("non-verbose mode strips data field from execution_log", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("execution_log_insert", {
        org_id: ctx.orgId,
        execution_id: execution.id,
        level: "info",
        message: "processing",
        data: { verbose: "details" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events[0]!.event).toBe("execution_log");

      const data = JSON.parse(events[0]!.data);
      // stripPayload removes "data" for execution_log in non-verbose mode
      expect(data).not.toHaveProperty("data");
      expect(data.message).toBe("processing");
    });

    it("verbose mode includes all fields", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}?verbose=true`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "success",
        package_id: flowPkg.id,
        result: { output: "data" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      const data = JSON.parse(events[0]!.data);
      // In verbose mode, result is NOT stripped
      expect(data.result).toEqual({ output: "data" });
      expect(data.id).toBe(execution.id);
    });

    it("verbose mode includes data field for execution_log", async () => {
      const res = await sseRequest(`/api/realtime/executions/${execution.id}?verbose=true`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("execution_log_insert", {
        org_id: ctx.orgId,
        execution_id: execution.id,
        level: "info",
        message: "step completed",
        data: { detail: "full-info" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events[0]!.event).toBe("execution_log");

      const data = JSON.parse(events[0]!.data);
      expect(data.data).toEqual({ detail: "full-info" });
    });
  });

  // ── GET /api/realtime/flows/:packageId/executions ───────────

  describe("GET /api/realtime/flows/:packageId/executions", () => {
    it("receives flow-scoped execution events", async () => {
      const res = await sseRequest(
        `/api/realtime/flows/${encodeURIComponent(flowPkg.id)}/executions`,
        ctx,
      );
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "running",
        package_id: flowPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("execution_update");

      const data = JSON.parse(events[0]!.data);
      expect(data.packageId).toBe(flowPkg.id);
      expect(data.id).toBe(execution.id);
    });

    it("ignores events from other flows", async () => {
      const otherFlow = await seedFlow({ orgId: ctx.orgId });

      const res = await sseRequest(
        `/api/realtime/flows/${encodeURIComponent(flowPkg.id)}/executions`,
        ctx,
      );
      expect(res.body).not.toBeNull();

      await wait();

      // Fire event for a different flow — should be filtered
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: "exec-other",
        status: "running",
        package_id: otherFlow.id,
      });
      await wait();

      // Fire event for the target flow — should be received
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "success",
        package_id: flowPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);

      const data = JSON.parse(events[0]!.data);
      expect(data.packageId).toBe(flowPkg.id);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        `/api/realtime/flows/${encodeURIComponent(flowPkg.id)}/executions?orgId=${ctx.orgId}`,
      );
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/realtime/executions ────────────────────────────

  describe("GET /api/realtime/executions", () => {
    it("receives all org execution events", async () => {
      const res = await sseRequest("/api/realtime/executions", ctx);
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "running",
        package_id: flowPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("execution_update");
    });

    it("receives events from multiple flows", async () => {
      const flow2 = await seedFlow({ orgId: ctx.orgId });
      const exec2 = await seedExecution({ packageId: flow2.id, orgId: ctx.orgId });

      const res = await sseRequest("/api/realtime/executions", ctx);
      expect(res.body).not.toBeNull();

      await wait();

      // Fire events for two different flows
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "running",
        package_id: flowPkg.id,
      });
      await wait(50);
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: exec2.id,
        status: "success",
        package_id: flow2.id,
      });

      const events = await collectSSEEvents(res.body!, 2, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(2);

      const ids = events.map((e) => JSON.parse(e.data).id);
      expect(ids).toContain(execution.id);
      expect(ids).toContain(exec2.id);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/realtime/executions");
      expect(res.status).toBe(401);
    });
  });

  // ── API key auth via ?token= ────────────────────────────────

  describe("API key auth via ?token=", () => {
    let apiKeyRaw: string;

    beforeEach(async () => {
      const res = await app.request("/api/api-keys", {
        method: "POST",
        headers: {
          Cookie: ctx.cookie,
          "X-Org-Id": ctx.orgId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "SSE Test Key",
          applicationId: ctx.defaultAppId,
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { key: string };
      apiKeyRaw = body.key;
    });

    it("authenticates with valid API key in token query param", async () => {
      const res = await app.request(`/api/realtime/executions?token=${apiKeyRaw}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    });

    it("returns 401 with invalid API key", async () => {
      const res = await app.request(`/api/realtime/executions?token=ask_invalid_key`);
      expect(res.status).toBe(401);
    });
  });

  // ── Cross-org isolation ─────────────────────────────────────

  describe("cross-org isolation", () => {
    it("org B SSE does not receive org A events", async () => {
      // Create a second org context
      const ctxB = await createTestContext();
      const flowB = await seedFlow({ orgId: ctxB.orgId });
      await seedExecution({ packageId: flowB.id, orgId: ctxB.orgId });

      // Open SSE for org B (all executions)
      const resB = await sseRequest("/api/realtime/executions", ctxB);
      expect(resB.body).not.toBeNull();

      await wait();

      // Fire event for org A — org B should NOT receive it
      await pgNotify("execution_update", {
        org_id: ctx.orgId,
        id: execution.id,
        status: "running",
        package_id: flowPkg.id,
      });
      await wait();

      // Fire event for org B — org B SHOULD receive it
      await pgNotify("execution_update", {
        org_id: ctxB.orgId,
        id: "exec-b",
        status: "success",
        package_id: flowB.id,
      });

      const events = await collectSSEEvents(resB.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);

      const data = JSON.parse(events[0]!.data);
      expect(data.orgId).toBe(ctxB.orgId);
      // Verify it is NOT org A's event
      expect(data.orgId).not.toBe(ctx.orgId);
    });
  });
});
