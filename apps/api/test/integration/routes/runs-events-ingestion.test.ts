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
 *   2. `result.report` / `result.output` / `result.checkpoint` sent with
 *      finalize land on `runs.result`. Before the tee sink merged
 *      aggregator fields into the finalize POST, tools that emitted
 *      `report.appended` via stdout produced an empty report column.
 *      This test is the server-side half of the contract: when the
 *      container POSTs a complete `result`, the row is complete too.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs, llmUsage } from "@appstrate/db/schema";
import { and } from "drizzle-orm";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import type { AppstrateModule, RunStatusChangeParams } from "@appstrate/core/module";

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
    /** Persisted on `runs.model_source` — forwarded to the `afterRun` hook. */
    modelSource?: string | null;
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
    ...(overrides.modelSource !== undefined ? { modelSource: overrides.modelSource } : {}),
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

  it("writes output + report + checkpoint from the finalize body onto runs.result", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const result = {
      memories: [{ content: "m1" }],
      checkpoint: { step: 3 },
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

  // ---------------------------------------------------------------------
  // Authoritative usage in the finalize body — closes the race window
  // where the side-channel `appstrate.metric` POST landed AFTER the
  // finalize POST, leading `runHadZeroTokens` to read a stale (zero)
  // `runs.tokenUsage` and flip a healthy run to "failed: could not
  // reach the LLM API". The runner now ships `usage` in the finalize
  // body and the platform reads it preferentially.
  // ---------------------------------------------------------------------
  it("uses result.usage as the authoritative zero-tokens signal (success path)", async () => {
    // DB column starts empty — proves the body, not the column, drives
    // the heuristic. A pre-fix run would have flipped to failed here.
    const runId = await seedRunWithSink(ctx, "@test/final-agent", { tokenUsage: null });

    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      usage: { input_tokens: 1234, output_tokens: 56 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
    // Finalize also persists usage from the body so the column reflects
    // truth even when the metric event was dropped (process exit, network).
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 1234, output_tokens: 56 });
  });

  it("flips to failed with LLM-unreachable when result.usage reports zero tokens", async () => {
    // Seed the column with a non-zero count to prove the body wins —
    // an authoritative `usage: {0, 0}` from the runner overrides any
    // late-arriving metric events that previously updated the column.
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 999, output_tokens: 999 },
    });

    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/could not reach the LLM API/);
    // Body wins on persistence too — the column ends at zero.
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("falls back to runs.tokenUsage when result.usage is absent (legacy runners)", async () => {
    // Runners that don't yet ship `usage` in the finalize body (older
    // CLI, third-party AFPS runners) must keep working — finalize falls
    // back to the side-channel-populated DB column.
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 50, output_tokens: 25 },
    });

    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      // no `usage` field
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
    // No `usage` in body → finalize MUST NOT overwrite the column.
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 50, output_tokens: 25 });
  });

  it("falls back to DB and flips to failed when neither body nor column has tokens", async () => {
    // The pre-fix failure mode at the legacy layer — preserved so
    // legitimate "agent never reached the LLM" cases still produce the
    // diagnostic instead of silently succeeding.
    const runId = await seedRunWithSink(ctx, "@test/final-agent", { tokenUsage: null });

    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      // no `usage` field
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/could not reach the LLM API/);
  });

  // ---------------------------------------------------------------------
  // Authoritative cost in the finalize body — closes the second race
  // window. The runtime emits `appstrate.metric` as fire-and-forget
  // POST and `process.exit(0)` immediately after finalize returns; if
  // the metric POST is aborted mid-flight we used to lose the runner-
  // source `llm_usage` ledger row entirely. Now finalize synthesises
  // the row from `result.cost` whenever the runner ledger is empty.
  // ---------------------------------------------------------------------
  it("synthesises a runner ledger row from result.cost when metric never landed", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    // No metric events posted — simulate `process.exit(0)` aborting the
    // fire-and-forget POST. Finalize MUST still attribute the cost.
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      usage: { input_tokens: 200, output_tokens: 100 },
      cost: 0.0042,
    });
    expect(res.status).toBe(200);

    // The finalize fallback writes the single runner row when the
    // metric event never arrived.
    const ledger = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.costUsd).toBeCloseTo(0.0042, 5);
    expect(ledger[0]!.inputTokens).toBe(200);
    expect(ledger[0]!.outputTokens).toBe(100);

    // runs.cost reflects the synthesised row.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.cost).toBeCloseTo(0.0042, 5);
  });

  it("does NOT duplicate the runner ledger row when a metric event already landed", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    // Metric arrives first — the platform persists the single
    // runner-source row.
    const ev = buildEnvelope(
      runId,
      "appstrate.metric",
      {
        usage: { input_tokens: 200, output_tokens: 100 },
        cost: 0.0042,
        timestamp: Date.now(),
      },
      1,
    );
    expect((await postEvent(runId, ev)).status).toBe(200);

    // Finalize ships the same `cost` in the body. The partial unique
    // index on `(run_id) WHERE source='runner'` guarantees a single
    // runner row regardless of which writer raced first.
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      usage: { input_tokens: 200, output_tokens: 100 },
      cost: 0.0042,
    });
    expect(res.status).toBe(200);

    const ledger = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.costUsd).toBeCloseTo(0.0042, 5);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.cost).toBeCloseTo(0.0042, 5);
  });

  it("does not synthesise when result.cost is zero — empty ledger stays empty", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });

    // A run that bridge-emitted `cost: 0` (e.g. cached LLM call, no
    // billable tokens) MUST NOT pollute the ledger with a $0 row.
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: 0,
    });
    expect(res.status).toBe(200);

    const ledger = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledger).toHaveLength(0);
  });

  // Cost-ledger end-to-end regression: before the llm_usage unification,
  // runs.cost was overwritten with null at finalize for platform runs
  // because aggregateRunCost only summed the proxy tables. Now finalize
  // reads the unified ledger, which includes the single runner-source
  // row written by the sink on the `appstrate.metric` event.
  it("accumulates runner-source cost into runs.cost at finalize", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    // Emit one metric event with the runner's final cost + usage.
    const ev = buildEnvelope(
      runId,
      "appstrate.metric",
      {
        usage: { input_tokens: 300, output_tokens: 125 },
        cost: 0.003,
        timestamp: Date.now(),
      },
      1,
    );
    expect((await postEvent(runId, ev)).status).toBe(200);

    // Single runner-source ledger row.
    const ledger = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.costUsd).toBeCloseTo(0.003, 5);

    // Finalize caches the aggregate into runs.cost.
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.cost).toBeCloseTo(0.003, 5);
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 300, output_tokens: 125 });
  });
});

// ---------------------------------------------------------------------------
// `afterRun` hook contract — finalize MUST forward `runs.model_source` so
// module billing handlers can distinguish platform-paid (system) runs from
// BYOK (org) runs. Skipping the field collapses every run to "system" in
// cloud's `recordUsage` fallback and silently bills runs the platform was
// never paid for.
// ---------------------------------------------------------------------------
describe("POST /api/runs/:runId/events/finalize — afterRun hook params", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    resetModules();
    ctx = await createTestContext({ email: "hook@test.dev", orgSlug: "hook-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/hook-agent", type: "agent" });
  });

  afterAll(() => {
    // Don't leak the spy module into sibling test files.
    resetModules();
  });

  async function captureAfterRunParams(): Promise<{
    captured: () => RunStatusChangeParams | null;
  }> {
    let last: RunStatusChangeParams | null = null;
    const mod: AppstrateModule = {
      manifest: { id: "afterrun-spy", name: "After-Run Spy", version: "1.0.0" },
      async init() {},
      hooks: {
        afterRun: async (params) => {
          last = params;
          return null;
        },
      },
    };
    await loadModulesFromInstances([mod], {
      databaseUrl: null,
      redisUrl: null,
      appUrl: "http://localhost:3000",
      isEmbeddedDb: true,
      applyMigrations: async () => {},
      getSendMail: async () => () => {},
      getOrgAdminEmails: async () => [],
      services: {} as never,
    });
    return { captured: () => last };
  }

  it("forwards runs.modelSource = 'system' to the afterRun hook", async () => {
    const { captured } = await captureAfterRunParams();
    const runId = await seedRunWithSink(ctx, "@test/hook-agent", { modelSource: "system" });
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
    });
    expect(res.status).toBe(200);
    expect(captured()).not.toBeNull();
    expect(captured()!.modelSource).toBe("system");
  });

  it("forwards runs.modelSource = 'org' (BYOK) to the afterRun hook so cloud skips billing", async () => {
    const { captured } = await captureAfterRunParams();
    const runId = await seedRunWithSink(ctx, "@test/hook-agent", { modelSource: "org" });
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
    });
    expect(res.status).toBe(200);
    expect(captured()).not.toBeNull();
    expect(captured()!.modelSource).toBe("org");
  });

  it("omits modelSource when the run row has none (legacy / inline runs)", async () => {
    const { captured } = await captureAfterRunParams();
    const runId = await seedRunWithSink(ctx, "@test/hook-agent", { modelSource: null });
    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
    });
    expect(res.status).toBe(200);
    expect(captured()).not.toBeNull();
    expect(captured()!.modelSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Liveness bumps — ingestion + /sink/extend + /events/heartbeat feed the
// same `last_heartbeat_at` column the stall watchdog reads. If any of
// these stops updating the column the runner's proof-of-life is
// invisible to the watchdog and a healthy run gets murdered as "stalled".
// ---------------------------------------------------------------------------
describe("runs liveness — unified last_heartbeat_at bumps", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "beat@test.dev", orgSlug: "beat-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/beat-agent", type: "agent" });
  });

  async function readHeartbeatMs(runId: string): Promise<number> {
    const [row] = await db
      .select({ lastHeartbeatAt: runs.lastHeartbeatAt })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    return row!.lastHeartbeatAt.getTime();
  }

  it("event ingestion bumps last_heartbeat_at to the write-time timestamp", async () => {
    // Seed with an old heartbeat so any future timestamp is a clear win.
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runs).values({
      id: runId,
      packageId: "@test/beat-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
      runOrigin: "remote",
      sinkSecretEncrypted: (await import("@appstrate/connect")).encrypt(RUN_SECRET),
      sinkExpiresAt: new Date(Date.now() + 3600_000),
      startedAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() - 5 * 60_000), // 5 min ago
      tokenUsage: { input_tokens: 100, output_tokens: 50 } as unknown as Record<string, number>,
    });

    const before = await readHeartbeatMs(runId);

    // Fire an event — implicit heartbeat.
    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "alive", timestamp: Date.now() },
      1,
    );
    const res = await postEvent(runId, envelope);
    expect(res.status).toBe(200);

    const after = await readHeartbeatMs(runId);
    expect(after).toBeGreaterThan(before);
  });

  it("POST /events/heartbeat is HMAC-authed and bumps last_heartbeat_at without advancing sequence", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runs).values({
      id: runId,
      packageId: "@test/beat-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
      runOrigin: "remote",
      sinkSecretEncrypted: (await import("@appstrate/connect")).encrypt(RUN_SECRET),
      sinkExpiresAt: new Date(Date.now() + 3600_000),
      startedAt: new Date(),
      lastHeartbeatAt: new Date(Date.now() - 5 * 60_000),
      tokenUsage: { input_tokens: 100, output_tokens: 50 } as unknown as Record<string, number>,
    });

    const before = await readHeartbeatMs(runId);
    const [rowBefore] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);

    // Non-empty JSON body — Hono/undici drop a truly empty body on fetch,
    // making the HMAC-signed bytes differ between client and server.
    // The route ignores the payload, so any valid JSON works.
    const body = "{}";
    const res = await app.request(`/api/runs/${runId}/events/heartbeat`, {
      method: "POST",
      headers: signedHeaders(RUN_SECRET, body),
      body,
    });
    expect(res.status).toBe(200);

    const after = await readHeartbeatMs(runId);
    const [rowAfter] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);

    expect(after).toBeGreaterThan(before);
    // Sequence counter untouched — heartbeat is out-of-band from the
    // event stream on purpose (no log row, no ordering semantics).
    expect(rowAfter?.lastEventSequence).toBe(rowBefore?.lastEventSequence);
  });

  it("heartbeat without a valid signature is rejected (same auth surface as events)", async () => {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runs).values({
      id: runId,
      packageId: "@test/beat-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "running",
      runOrigin: "remote",
      sinkSecretEncrypted: (await import("@appstrate/connect")).encrypt(RUN_SECRET),
      sinkExpiresAt: new Date(Date.now() + 3600_000),
      startedAt: new Date(),
      tokenUsage: { input_tokens: 100, output_tokens: 50 } as unknown as Record<string, number>,
    });

    // Signed with the wrong secret — middleware must reject. An attacker
    // who could spoof heartbeats would keep dead runs alive forever.
    const body = "{}";
    const res = await app.request(`/api/runs/${runId}/events/heartbeat`, {
      method: "POST",
      headers: signedHeaders("z".repeat(43), body),
      body,
    });
    expect(res.status).toBe(401);
  });
});
