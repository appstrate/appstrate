// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the HMAC-signed event-ingestion path:
 * `POST /api/runs/:runId/events` + `POST /api/runs/:runId/events/finalize`.
 *
 * Protects two fixes introduced after the stdout-JSONL → HttpSink
 * transport swap:
 *
 *   1. Ingestion + finalize MUST not crash when the platform is booted
 *      without Redis (Tier 0 dev mode). Before the `EventBuffer` +
 *      `getCache()` abstractions landed, every event POST called
 *      `getRedisConnection()` directly — which throws on `REDIS_URL`
 *      absence, stalling every run at `status=running`. The tests here
 *      go through the same `getCache()` / `getEventBuffer()` indirection
 *      the production code uses; running them in both Redis and
 *      non-Redis modes would require module-reload gymnastics, so we
 *      assert the data-plane contract (events persist → finalize writes
 *      the complete row) which would fail in either infra mode if the
 *      abstractions were bypassed.
 *
 *   2. `result.report` / `result.output` / `result.state` sent with
 *      finalize land on `runs.result`. Before the tee sink merged
 *      aggregator fields into the finalize POST, tools that emitted
 *      `report.appended` via stdout produced an empty report column.
 *      This test is the server-side half of the contract: when the
 *      container POSTs a complete `result`, the row is complete too.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";

const app = getTestApp();

const RUN_SECRET = "a".repeat(43); // matches mintSinkCredentials base64url(32 bytes)

function signedHeaders(secret: string, body: string) {
  const msgId = `msg_${crypto.randomUUID()}`;
  const timestampSec = Math.floor(Date.now() / 1000);
  const headers = sign({ msgId, timestampSec, body, secret });
  return {
    "Content-Type": "application/json",
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedRunWithSink(
  ctx: TestContext,
  packageId: string,
  overrides: {
    status?: "pending" | "running" | "success" | "failed" | "timeout" | "cancelled";
    sinkClosedAt?: Date | null;
    /**
     * Pre-seed non-zero token usage so `finalizeRun`'s zero-tokens
     * heuristic does not flip `success` → `failed`. Set `null` to leave
     * the row without usage (exercises the heuristic on purpose).
     */
    tokenUsage?: Record<string, number> | null;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: overrides.status ?? "running",
    runOrigin: "platform",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    sinkClosedAt: overrides.sinkClosedAt ?? null,
    startedAt: new Date(),
    tokenUsage:
      overrides.tokenUsage === undefined
        ? { input_tokens: 100, output_tokens: 50 }
        : overrides.tokenUsage,
  });
  return runId;
}

async function postEvent(runId: string, envelope: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(envelope);
  return app.request(`/api/runs/${runId}/events`, {
    method: "POST",
    headers: signedHeaders(RUN_SECRET, body),
    body,
  });
}

async function postFinalize(runId: string, result: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(result);
  return app.request(`/api/runs/${runId}/events/finalize`, {
    method: "POST",
    headers: signedHeaders(RUN_SECRET, body),
    body,
  });
}

function buildEnvelope(
  runId: string,
  type: string,
  data: Record<string, unknown>,
  sequence: number,
): Record<string, unknown> {
  return {
    specversion: "1.0",
    type,
    source: `/afps/runs/${runId}`,
    id: `msg_${crypto.randomUUID()}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
    sequence,
  };
}

describe("POST /api/runs/:runId/events — ingestion without Redis-specific coupling", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "ingest@test.dev", orgSlug: "ingest-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/ingest-agent", type: "agent" });
  });

  it("persists a single signed event and advances the sequence counter", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "hello", timestamp: Date.now() },
      1,
    );
    const res = await postEvent(runId, envelope);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: string; sequence: number };
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("persisted");
    expect(body.sequence).toBe(1);

    // Counter advanced on the run row.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.lastEventSequence).toBe(1);

    // Event wrote a run_logs row (the write-through confirming the
    // AppstrateEventSink dispatch completed without throwing).
    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs.length).toBeGreaterThan(0);
  });

  it("dedupes replayed webhook-ids — a second POST with the same id returns replay", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");
    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "once", timestamp: Date.now() },
      1,
    );
    const body = JSON.stringify(envelope);
    const headers = signedHeaders(RUN_SECRET, body);

    const a = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers,
      body,
    });
    const b = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers, // same webhook-id
      body,
    });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as { outcome: string }).outcome).toBe("persisted");
    expect(((await b.json()) as { outcome: string }).outcome).toBe("replay");
  });

  it("buffers out-of-order events and drains them when the missing sequence arrives", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    // Out of order: 2 before 1 → seq=2 gets buffered.
    const env2 = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "second", timestamp: Date.now() },
      2,
    );
    const res2 = await postEvent(runId, env2);
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { outcome: string }).outcome).toBe("buffered");

    // Counter did NOT advance — still 0.
    const [mid] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(mid?.lastEventSequence).toBe(0);

    // Now seq=1 arrives → drains both (1, then 2) in order.
    const env1 = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "first", timestamp: Date.now() },
      1,
    );
    const res1 = await postEvent(runId, env1);
    expect(res1.status).toBe(200);

    const [after] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(after?.lastEventSequence).toBe(2);
  });

  // Regression for the HttpSink off-by-one: the first event emitted by
  // HttpSink carries sequence=1 (not 0). With `last_event_sequence`
  // defaulting to 0, `sequence === last + 1` must accept 1 on the
  // fast-path — a bug here drops the first event as replay and the user
  // loses the boot-phase logs.
  it("persists the first event (sequence=1) on the fast-path", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent", { status: "pending" });

    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "first log", timestamp: Date.now() },
      1,
    );
    const res = await postEvent(runId, envelope);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; sequence?: number };
    expect(body.outcome).toBe("persisted");
    expect(body.sequence).toBe(1);

    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs.length).toBeGreaterThan(0);
  });

  // The server-side `run.started` consumer is the handoff that flips
  // `pending → running` for remote runs. Runners never emit it in practice,
  // so the status flip has to be driven by the first event — regardless of
  // its type — or remote runs stay stuck at `pending` until finalize.
  it("flips status pending → running on the first ingested event", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent", { status: "pending" });

    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "first", timestamp: Date.now() },
      1,
    );
    const res = await postEvent(runId, envelope);
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("running");
  });
});

describe("POST /api/runs/:runId/events/finalize — complete result persistence", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "finalize@test.dev", orgSlug: "finalize-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/final-agent", type: "agent" });
  });

  it("writes output + report + state from the finalize body onto runs.result", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const result = {
      memories: [{ content: "m1" }],
      state: { step: 3 },
      output: { answer: 42 },
      report: "# Report\nparagraph",
      logs: [],
      status: "success",
      durationMs: 1234,
    };
    const res = await postFinalize(runId, result);
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.duration).toBe(1234);
    expect(row?.sinkClosedAt).not.toBeNull();

    const persisted = row?.result as { output?: unknown; report?: unknown } | null;
    expect(persisted).not.toBeNull();
    expect(persisted?.output).toEqual({ answer: 42 });
    expect(persisted?.report).toBe("# Report\nparagraph");
  });

  it("idempotent — once the sink is closed, further finalize POSTs reject with 410", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const first = { status: "success", output: { v: 1 }, durationMs: 10 };
    const second = { status: "success", output: { v: 2 }, durationMs: 20 };

    const a = await postFinalize(runId, first);
    expect(a.status).toBe(200);

    // First write closed the sink (`sink_closed_at` now set). The
    // `assertSinkOpen` middleware rejects subsequent POSTs with 410 Gone —
    // the contract that keeps platform synthesis and container-posted
    // finalize from racing each other on live runs.
    const b = await postFinalize(runId, second);
    expect(b.status).toBe(410);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    const persisted = row?.result as { output?: { v: number } } | null;
    // First write wins.
    expect(persisted?.output?.v).toBe(1);
    expect(row?.duration).toBe(10);
  });

  // Regression for the CAS-ordering bug: side effects (log appends,
  // memory inserts, output_validation log) used to fire *before* the CAS
  // update, so a concurrent synthesiseFinalize racing with a
  // container-posted finalize duplicated log rows. Asserting that the
  // loser's second call produces exactly zero extra rows protects the
  // invariant after the re-ordering.
  it("CAS-guards all side effects — only the winning finalize writes log rows", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const body = { status: "success", output: { v: 1 }, report: "ok", durationMs: 10 };

    const [a, b] = await Promise.all([postFinalize(runId, body), postFinalize(runId, body)]);

    // At least one caller observes success; the loser may see 200 (CAS
    // no-op after passing the assertSinkOpen middleware gate) or 410
    // (gate rejected it because the winner already closed the sink).
    // Both outcomes are correct — what matters is the exactly-once
    // invariant on side effects below.
    expect([a.status, b.status]).toContain(200);

    // Only one `run_completed` log row — duplicate would indicate side
    // effects fired outside the CAS-protected region.
    const completedLogs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    const runCompleted = completedLogs.filter((l) => l.event === "run_completed");
    expect(runCompleted.length).toBe(1);
  });

  it("finalize after cancel is a no-op (sink already closed by the cancel route)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      status: "cancelled",
      sinkClosedAt: new Date(),
    });

    const res = await postFinalize(runId, { status: "success", output: { late: true } });
    // The route returns 410 gone when the sink is closed.
    expect(res.status).toBe(410);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("cancelled");
    expect(row?.result).toBeNull();
  });
});
