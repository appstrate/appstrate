// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for SSE realtime routes.
 *
 * Tests the actual HTTP SSE format returned by the three realtime endpoints:
 *   - GET /api/realtime/runs/:id
 *   - GET /api/realtime/agents/:packageId/runs
 *   - GET /api/realtime/runs
 *
 * These tests verify the full pipeline: HTTP request -> auth -> SSE stream -> PG NOTIFY -> event delivery.
 * The underlying subscriber logic is already tested in services/realtime.test.ts.
 */
import { describe, expect, it, beforeEach, beforeAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll, db } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun, seedApplication } from "../../helpers/seed.ts";
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
  const url = `${path}${separator}orgId=${ctx.orgId}&appId=${ctx.defaultAppId}`;
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
  let agentPkg: Awaited<ReturnType<typeof seedAgent>>;
  let run: Awaited<ReturnType<typeof seedRun>>;

  beforeAll(async () => {
    await initRealtime();
  });

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    agentPkg = await seedAgent({ orgId: ctx.orgId });
    run = await seedRun({
      packageId: agentPkg.id,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
    });
  });

  // ── GET /api/realtime/runs/:id ────────────────────────

  describe("GET /api/realtime/runs/:id", () => {
    it("returns SSE content-type header", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.status).toBe(200);
      const contentType = res.headers.get("content-type");
      expect(contentType).toContain("text/event-stream");
      // Cancel stream to clean up
      await res.body?.cancel();
    });

    it("receives run_update events in SSE format", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      // Fire PG NOTIFY after a short delay to ensure subscriber is registered
      await wait();
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "running",
        package_id: agentPkg.id,
      });

      // Collect: first event should be ping (from keep-alive), then our run_update
      // But ping has 30s delay, so the run_update should arrive first
      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("run_update");

      const data = JSON.parse(events[0]!.data);
      expect(data.id).toBe(run.id);
      expect(data.status).toBe("running");
      expect(data.orgId).toBe(ctx.orgId);
      expect(data.packageId).toBe(agentPkg.id);
    });

    it("receives ping as first event", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.body).not.toBeNull();

      // The first event from the SSE stream should be a ping (keep-alive)
      const events = await collectSSEEvents(res.body!, 1, { timeoutMs: 3000 });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("ping");
      expect(events[0]!.data).toBe("");
    });

    // #278 item E — every SSE frame must carry an `id:` field per the HTML SSE
    // spec. The id format is `${subId}:${monotonic}` so dedup-by-id is safe
    // even across reconnects (subId is fresh per connection). Server-side
    // replay via `Last-Event-ID` is NOT implemented; reconnect lands on the
    // live tail.
    it("emits a per-stream-monotonic `id:` field with a stable subId prefix", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "running",
        package_id: agentPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 2, { timeoutMs: 3000 });
      expect(events.length).toBe(2);

      // Format: `${subId}:${monotonic}`. We don't assert the subId itself
      // (random per connection) — only that the format holds and the
      // monotonic suffix increments.
      const id0 = events[0]!.id!;
      const id1 = events[1]!.id!;
      expect(id0).toMatch(/^.+:1$/);
      expect(id1).toMatch(/^.+:2$/);
      const [prefix0, suffix0] = id0.split(":");
      const [prefix1, suffix1] = id1.split(":");
      // Same connection → same subId prefix.
      expect(prefix1).toBe(prefix0);
      // Monotonic strictly-increasing within a connection.
      expect(Number(suffix1)).toBeGreaterThan(Number(suffix0));
    });

    // Regression: an earlier implementation reset `nextEventId` to 1 on
    // every reconnect, so a client doing `if (id === lastSeenId) skip`
    // would silently drop fresh events because ids "1", "2", "3"
    // repeated on the second stream. The id format
    // `${subId}:${monotonic}` makes ids globally unique because subId
    // is freshly generated per connection. This test asserts that two
    // back-to-back EventSource connections never collide on `id`.
    it("emits ids that are unique across reconnects", async () => {
      const first = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(first.body).not.toBeNull();
      const firstEvents = await collectSSEEvents(first.body!, 1, { timeoutMs: 3000 });
      expect(firstEvents.length).toBe(1);
      // After collectSSEEvents the body reader has been released; we
      // can't `cancel()` directly without re-locking. Letting the
      // first stream go out of scope is sufficient — the SSE handler
      // observes the closed underlying connection on its next write.

      // Reconnect — fresh subscription = fresh subId.
      const second = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(second.body).not.toBeNull();
      const secondEvents = await collectSSEEvents(second.body!, 1, { timeoutMs: 3000 });
      expect(secondEvents.length).toBe(1);

      // The id from the second connection MUST NOT equal any id from
      // the first — the subId prefix changes per connection, so even
      // though both streams emit a "first ping" the full id string
      // differs.
      expect(secondEvents[0]!.id).not.toBe(firstEvents[0]!.id);

      const [firstPrefix] = firstEvents[0]!.id!.split(":");
      const [secondPrefix] = secondEvents[0]!.id!.split(":");
      expect(secondPrefix).not.toBe(firstPrefix);
    });

    it("returns 401 without cookie", async () => {
      const res = await app.request(`/api/realtime/runs/${run.id}?orgId=${ctx.orgId}`);
      expect(res.status).toBe(401);
    });

    it("returns 401 without orgId query param", async () => {
      const res = await app.request(`/api/realtime/runs/${run.id}`, {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 without appId query param", async () => {
      const res = await app.request(`/api/realtime/runs/${run.id}?orgId=${ctx.orgId}`, {
        headers: { Cookie: ctx.cookie },
      });
      expect(res.status).toBe(401);
    });

    it("app-scoped SSE — events from other apps are filtered out", async () => {
      const appB = await seedApplication({ orgId: ctx.orgId, name: "SSE AppB" });
      const appBRun = await seedRun({
        packageId: agentPkg.id,
        orgId: ctx.orgId,
        applicationId: appB.id,
      });

      // Subscribe from default app (AppA)
      const res = await sseRequest(`/api/realtime/runs`, ctx);
      expect(res.body).not.toBeNull();

      await wait();

      // Fire event for AppB — should NOT be received by AppA subscriber
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: appB.id,
        id: appBRun.id,
        status: "running",
        package_id: agentPkg.id,
      });
      await wait();

      // Fire event for AppA — should be received
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "success",
        package_id: agentPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(JSON.parse(events[0]!.data).id).toBe(run.id);
    });

    it("filters events by runId — ignores other runs", async () => {
      const otherExec = await seedRun({
        packageId: agentPkg.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
      });

      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();

      // Fire event for a different run — should be filtered out
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: otherExec.id,
        status: "running",
        package_id: agentPkg.id,
      });
      await wait();

      // Fire event for the target run — should be received
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "success",
        package_id: agentPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("run_update");

      const data = JSON.parse(events[0]!.data);
      expect(data.id).toBe(run.id);
      expect(data.status).toBe("success");
    });

    it("non-verbose mode strips result field from run_update", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "success",
        package_id: agentPkg.id,
        result: { some: "large-data" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      const data = JSON.parse(events[0]!.data);
      // stripPayload removes "result" for run_update in non-verbose mode
      expect(data).not.toHaveProperty("result");
      expect(data.id).toBe(run.id);
    });

    it("non-verbose mode strips data field from run_log", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_log_insert", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        run_id: run.id,
        level: "info",
        message: "processing",
        data: { verbose: "details" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events[0]!.event).toBe("run_log");

      const data = JSON.parse(events[0]!.data);
      // stripPayload removes "data" for run_log in non-verbose mode
      expect(data).not.toHaveProperty("data");
      expect(data.message).toBe("processing");
    });

    it("verbose mode includes all fields", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}?verbose=true`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "success",
        package_id: agentPkg.id,
        result: { output: "data" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      const data = JSON.parse(events[0]!.data);
      // In verbose mode, result is NOT stripped
      expect(data.result).toEqual({ output: "data" });
      expect(data.id).toBe(run.id);
    });

    it("verbose mode includes data field for run_log", async () => {
      const res = await sseRequest(`/api/realtime/runs/${run.id}?verbose=true`, ctx);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_log_insert", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        run_id: run.id,
        level: "info",
        message: "step completed",
        data: { detail: "full-info" },
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events[0]!.event).toBe("run_log");

      const data = JSON.parse(events[0]!.data);
      expect(data.data).toEqual({ detail: "full-info" });
    });
  });

  // ── GET /api/realtime/agents/:packageId/runs ───────────

  describe("GET /api/realtime/agents/:packageId/runs", () => {
    it("receives agent-scoped run events", async () => {
      const res = await sseRequest(
        `/api/realtime/agents/${encodeURIComponent(agentPkg.id)}/runs`,
        ctx,
      );
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "running",
        package_id: agentPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("run_update");

      const data = JSON.parse(events[0]!.data);
      expect(data.packageId).toBe(agentPkg.id);
      expect(data.id).toBe(run.id);
    });

    it("ignores events from other agents", async () => {
      const otherAgent = await seedAgent({ orgId: ctx.orgId });

      const res = await sseRequest(
        `/api/realtime/agents/${encodeURIComponent(agentPkg.id)}/runs`,
        ctx,
      );
      expect(res.body).not.toBeNull();

      await wait();

      // Fire event for a different agent — should be filtered
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: "exec-other",
        status: "running",
        package_id: otherAgent.id,
      });
      await wait();

      // Fire event for the target agent — should be received
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "success",
        package_id: agentPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);

      const data = JSON.parse(events[0]!.data);
      expect(data.packageId).toBe(agentPkg.id);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        `/api/realtime/agents/${encodeURIComponent(agentPkg.id)}/runs?orgId=${ctx.orgId}`,
      );
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/realtime/runs ────────────────────────────

  describe("GET /api/realtime/runs", () => {
    it("receives all org run events", async () => {
      const res = await sseRequest("/api/realtime/runs", ctx);
      expect(res.status).toBe(200);
      expect(res.body).not.toBeNull();

      await wait();
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "running",
        package_id: agentPkg.id,
      });

      const events = await collectSSEEvents(res.body!, 1, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(1);
      expect(events[0]!.event).toBe("run_update");
    });

    it("receives events from multiple agents", async () => {
      const agent2 = await seedAgent({ orgId: ctx.orgId });
      const exec2 = await seedRun({
        packageId: agent2.id,
        orgId: ctx.orgId,
        applicationId: ctx.defaultAppId,
      });

      const res = await sseRequest("/api/realtime/runs", ctx);
      expect(res.body).not.toBeNull();

      await wait();

      // Fire events for two different agents
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "running",
        package_id: agentPkg.id,
      });
      await wait(50);
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: exec2.id,
        status: "success",
        package_id: agent2.id,
      });

      const events = await collectSSEEvents(res.body!, 2, {
        timeoutMs: 3000,
        ignoreEvents: ["ping"],
      });
      expect(events.length).toBe(2);

      const ids = events.map((e) => JSON.parse(e.data).id);
      expect(ids).toContain(run.id);
      expect(ids).toContain(exec2.id);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/api/realtime/runs");
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
          ...authHeaders(ctx),
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
      const res = await app.request(`/api/realtime/runs?token=${apiKeyRaw}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    });

    it("returns 401 with invalid API key", async () => {
      const res = await app.request(`/api/realtime/runs?token=ask_invalid_key`);
      expect(res.status).toBe(401);
    });
  });

  // ── Cross-org isolation ─────────────────────────────────────

  describe("cross-org isolation", () => {
    it("org B SSE does not receive org A events", async () => {
      // Create a second org context
      const ctxB = await createTestContext();
      const agentB = await seedAgent({ orgId: ctxB.orgId });
      await seedRun({ packageId: agentB.id, orgId: ctxB.orgId, applicationId: ctxB.defaultAppId });

      // Open SSE for org B (all runs)
      const resB = await sseRequest("/api/realtime/runs", ctxB);
      expect(resB.body).not.toBeNull();

      await wait();

      // Fire event for org A — org B should NOT receive it
      await pgNotify("run_update", {
        org_id: ctx.orgId,
        application_id: ctx.defaultAppId,
        id: run.id,
        status: "running",
        package_id: agentPkg.id,
      });
      await wait();

      // Fire event for org B — org B SHOULD receive it
      await pgNotify("run_update", {
        org_id: ctxB.orgId,
        application_id: ctxB.defaultAppId,
        id: "exec-b",
        status: "success",
        package_id: agentB.id,
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
