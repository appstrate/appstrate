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
 *   2. `result.output` / `result.checkpoint` sent with
 *      finalize land on `runs.result`. Before the tee sink merged
 *      aggregator fields into the finalize POST, tools that emitted
 *      events via stdout produced an empty result column.
 *      This test is the server-side half of the contract: when the
 *      container POSTs a complete `result`, the row is complete too.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs, llmUsage, packages } from "@appstrate/db/schema";
import { and } from "drizzle-orm";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage, seedPackageVersion } from "../../helpers/seed.ts";
import { loadModulesFromInstances, resetModules } from "../../../src/lib/modules/module-loader.ts";
import {
  finalizeRun,
  getRunSinkContext,
  synthesiseFinalize,
  capUtf8Text,
} from "../../../src/services/run-event-ingestion.ts";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { getRunFull } from "../../../src/services/state/runs.ts";
import type { RunArtifactsSummary } from "@appstrate/db/schema";
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
    /** Persisted on `runs.modelSource` — forwarded to the `afterRun` hook. */
    modelSource?: string | null;
    /** Persisted on `runs.versionRef` — pins the manifest finalize validates against. */
    versionRef?: string;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: overrides.status ?? "running",
    ...(overrides.versionRef !== undefined ? { versionRef: overrides.versionRef } : {}),
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

  it("persists a deprecated report.appended envelope for older runners", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    const envelope = buildEnvelope(runId, "report.appended", { content: "legacy report body" }, 1);
    const res = await postEvent(runId, envelope);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: string; sequence: number };
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe("persisted");
    expect(body.sequence).toBe(1);

    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.event).toBe("report");
    expect(logs[0]!.data).toEqual({ content: "legacy report body" });
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

  // Regression for the buffer-stuck-until-finalize bug.
  //
  // Symptom: on a 10-tool parallel turn, the runner's HttpSink fires 10
  // POSTs near-simultaneously. `verifyRunSignature` middleware loads each
  // request's snapshot of `lastEventSequence` BEFORE any of them
  // persists, so all 10 see the same stale value. Only one (whichever
  // matches `seq === snap + 1`) wins the fast path; the other 9 fall
  // into the buffer path. Pre-fix, the buffer path did NOT re-attempt a
  // drain — those 9 events sat in Redis until finalize's gap_fill,
  // collapsing 30s of real-time event activity into a single visual
  // burst at run end.
  //
  // We simulate the snapshot-staleness window by hand-advancing
  // `lastEventSequence` between the two POSTs to mimic a fast-path
  // request that completed between request A's middleware snapshot and
  // request A's drain attempt.
  it("buffer path refreshes snapshot and drains when DB has advanced", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    // Step 1: POST seq=3 with DB.lastSeq=0 → buffered (gap before).
    const env3 = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "third", timestamp: Date.now() },
      3,
    );
    const res3 = await postEvent(runId, env3);
    expect(res3.status).toBe(200);
    expect(((await res3.json()) as { outcome: string }).outcome).toBe("buffered");

    const [mid1] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(mid1?.lastEventSequence).toBe(0);

    // Step 2: simulate a concurrent fast-path that advanced DB to seq=2
    // without leaving anything in the buffer. Pre-fix, the buffer entry
    // for seq=3 stays untouched — no contiguous arrival ever wakes the
    // drain.
    await db.update(runs).set({ lastEventSequence: 2 }).where(eq(runs.id, runId));

    // Step 3: POST seq=4. Middleware reads fresh snapshot=2; 4 != 3 →
    // buffer path. With the fix, the buffer path's refresh-and-drain
    // now sees DB.lastSeq=2 and seq=3 in the buffer (contiguous!),
    // persists seq=3, then peeks seq=4 (just buffered), persists. Final
    // lastSeq=4. Without the fix, both 3 and 4 sit in the buffer and
    // lastSeq stays at 2 until finalize.
    const env4 = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "fourth", timestamp: Date.now() },
      4,
    );
    const res4 = await postEvent(runId, env4);
    expect(res4.status).toBe(200);

    const [after] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(after?.lastEventSequence).toBe(4);
  });

  // Regression for the silent-event-drop on bursty parallel turns.
  //
  // Symptom: on a 10-tool parallel turn, the 10 `tool_execution_end`
  // rows were missing from `run_logs` even though the runner POSTed
  // every event. The runner's HttpSink assigns sequence numbers
  // synchronously but the fetch calls race, so events past the contiguous
  // prefix land at the platform out of order and get buffered. When
  // some intermediate sequence's POST never won the fast-path CAS,
  // every later buffered event sat in the buffer until finalize's
  // `drainBufferedEvents(allowGaps: true)`. The gap_fill branch called
  // `persistEventAndAdvance(seq=56)` but the strict CAS predicate
  // `lastEventSequence = seq - 1` rejected it (`last` was still 32),
  // the buffer entry was removed regardless, and the row was silently
  // lost. The fix relaxes the CAS to `lastEventSequence < seq` in
  // allowGap mode so the jump is honoured.
  it("finalize drains buffered events past a sequence gap (gap_fill regression)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    // Plant a 50-event burst entirely past a gap: seq=1 is missing,
    // seq=2..51 all post out-of-order so they go to buffer.
    for (const sequence of [3, 5, 4, 7, 6, 2, 9, 8, 11, 10]) {
      const env = buildEnvelope(
        runId,
        "appstrate.progress",
        { message: `gap-${sequence}`, timestamp: Date.now() },
        sequence,
      );
      const res = await postEvent(runId, env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { outcome: string }).outcome).toBe("buffered");
    }

    const [mid] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(mid?.lastEventSequence).toBe(0);

    // Finalize triggers drainBufferedEvents(allowGaps: true). Without the
    // gap_fill CAS fix, every seq=2..11 buffered event would be removed
    // from the buffer with no dispatch — run_logs would have zero rows
    // from this batch.
    const res = await postFinalize(runId, {
      status: "success",
      durationMs: 100,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(after?.lastEventSequence).toBe(11);
    expect(after?.sinkClosedAt).not.toBeNull();

    const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
    const gapLogs = logs.filter(
      (l) => typeof l.message === "string" && l.message.startsWith("gap-"),
    );
    expect(gapLogs.length).toBe(10);
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

  // Regression for the persist-vs-CAS race in `persistEventAndAdvance`.
  //
  // Before the fix, `sink.handle(event)` ran BEFORE the CAS that
  // advances `runs.last_event_sequence`. Two concurrent ingestion
  // paths could both observe `lastSeq === sequence - 1` (the in-memory
  // snapshot taken at request start), both call `appendRunLog`, and
  // both insert an identical `run_logs` row for the same sequence —
  // only the CAS losing the race would no-op, but the row was already
  // double-written. `appendRunLog` has no idempotency key and the
  // platform-wide replay cache only dedupes on `(runId, webhookId)`,
  // not `(runId, sequence)`, so it cannot save us here.
  //
  // The race manifested in production as identical paired log rows
  // (same `data`, same `toolCallId`, `created_at` ~1ms apart) on
  // tool-heavy turns where the event throughput exposed enough drain
  // concurrency for two requests to peek the same buffered sequence.
  //
  // The fix in `persistEventAndAdvance` reverses the order: CAS first,
  // then dispatch. The loser observes zero affected rows and skips
  // the insert entirely — at most one row per sequence, period.
  it("inserts at most one run_logs row per sequence under concurrent posts", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    // Two POSTs with the SAME sequence but DIFFERENT webhook-ids (the
    // replay cache cannot dedupe these). Each `signedHeaders()` call
    // mints a fresh msg-id, so both pass the replay check and both
    // reach `persistEventAndAdvance` with `sequence === lastSeq + 1`.
    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "racing-event", timestamp: Date.now() },
      1,
    );
    // `Promise.all` is the closest we can get to a true race in a
    // single-threaded test runner — both POSTs enter the route
    // handler before either yields back from `await c.req.json()`.
    const [a, b] = await Promise.all([postEvent(runId, envelope), postEvent(runId, envelope)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    // Exactly one row, regardless of which request won the CAS.
    const logs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.message, "racing-event")));
    expect(logs).toHaveLength(1);

    // Sequence counter advanced exactly once.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.lastEventSequence).toBe(1);
  });

  // Regression: CAS-advance and run_logs INSERT MUST commit or roll back
  // together. Before the transaction wrap, a transient INSERT failure
  // (FK violation, check constraint, deadlock, network drop mid-statement)
  // left `runs.last_event_sequence` advanced with no row in `run_logs` —
  // the next event's CAS predicate `= seq - 1` matched the advanced
  // value and silently skipped the missing row. The fix wraps the CAS
  // and the dispatch in `db.transaction()` so either both apply or
  // neither does.
  //
  // We simulate a transient failure by adding a CHECK constraint that
  // rejects a marker message. The dispatch INSERT throws inside the tx,
  // rolling the CAS back.
  it("rolls back the sequence advance when the run_logs INSERT fails", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    await db.execute(
      sql`ALTER TABLE run_logs ADD CONSTRAINT _test_reject_poison CHECK (message != '__poison__')`,
    );

    try {
      const envelope = buildEnvelope(
        runId,
        "appstrate.progress",
        { message: "__poison__", timestamp: Date.now() },
        1,
      );
      const res = await postEvent(runId, envelope);
      // The transaction aborts on the CHECK violation; the route surfaces
      // an unhandled error as a 5xx. Either 500 or a problem+json shape
      // is acceptable — the contract is the rollback below.
      expect(res.status).toBeGreaterThanOrEqual(500);

      // CAS was rolled back: counter still 0.
      const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      expect(row?.lastEventSequence).toBe(0);

      // No log row was inserted.
      const logs = await db.select().from(runLogs).where(eq(runLogs.runId, runId));
      expect(logs).toHaveLength(0);
    } finally {
      await db.execute(sql`ALTER TABLE run_logs DROP CONSTRAINT _test_reject_poison`);
    }
  });

  // Regression: the replay-protection key must be released when ingestion
  // throws so the runner's retry (same webhook-id, same body, same HMAC
  // signature) is not silently absorbed as "replay" → 200 OK with the
  // event never persisted. Models the production case where HttpSink
  // retries a transient 5xx with the identical envelope.
  it("releases the replay key when ingestion throws so a retry can succeed", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");

    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "__poison__", timestamp: Date.now() },
      1,
    );
    const body = JSON.stringify(envelope);
    const stickyHeaders = signedHeaders(RUN_SECRET, body);

    await db.execute(
      sql`ALTER TABLE run_logs ADD CONSTRAINT _test_reject_poison CHECK (message != '__poison__')`,
    );

    const first = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: stickyHeaders,
      body,
    });
    expect(first.status).toBeGreaterThanOrEqual(500);

    // Lift the transient failure and retry with the EXACT SAME envelope
    // (same body, same webhook-id, same HMAC). Before the cleanup the
    // replay key was sticky for `replayWindow` seconds and this retry
    // would have been swallowed as "replay" with the event never
    // persisted.
    await db.execute(sql`ALTER TABLE run_logs DROP CONSTRAINT _test_reject_poison`);

    const second = await app.request(`/api/runs/${runId}/events`, {
      method: "POST",
      headers: stickyHeaders,
      body,
    });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { outcome: string }).outcome).toBe("persisted");

    // And the event actually landed in run_logs (proves the retry did
    // real ingestion, not a stale-key passthrough).
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.lastEventSequence).toBe(1);
    const logs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.message, "__poison__")));
    expect(logs).toHaveLength(1);
  });

  // Phase 2: a `document.published` event (emitted by the publish_document
  // tool / outputs sweep once the documents row already exists) must persist a
  // run_log so the published document streams over the run_log SSE and replays.
  it("document.published events persist as run_logs(type='result', event='document')", async () => {
    const runId = await seedRunWithSink(ctx, "@test/ingest-agent");
    const payload = {
      document_id: "doc_abc12345",
      uri: "document://doc_abc12345",
      name: "report.html",
      mime: "text/html",
      size: 1234,
      sha256: "f".repeat(64),
    };
    const envelope = buildEnvelope(runId, "document.published", payload, 1);
    const res = await postEvent(runId, envelope);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("persisted");

    const docLogs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.event, "document")));
    expect(docLogs).toHaveLength(1);
    expect(docLogs[0]!.type).toBe("result");
    expect(docLogs[0]!.data).toMatchObject({
      document_id: "doc_abc12345",
      uri: "document://doc_abc12345",
      name: "report.html",
      mime: "text/html",
      size: 1234,
    });
  });
});

describe("POST /api/runs/:runId/events/finalize — complete result persistence", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "finalize@test.dev", orgSlug: "finalize-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/final-agent", type: "agent" });
  });

  it("writes output + checkpoint from the finalize body onto runs.result", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const result = {
      memories: [{ content: "m1" }],
      checkpoint: { step: 3 },
      output: { answer: 42 },
      logs: [],
      status: "success",
      durationMs: 1234,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const res = await postFinalize(runId, result);
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.duration).toBe(1234);
    expect(row?.sinkClosedAt).not.toBeNull();

    const persisted = row?.result as { output?: unknown } | null;
    expect(persisted).not.toBeNull();
    expect(persisted?.output).toEqual({ answer: 42 });
  });

  it("persists the artifacts summary from the finalize body onto runs.artifacts", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const artifacts = {
      status: "partial",
      published: 2,
      failed: [{ name: "outputs/big.csv", code: "file_too_large" }],
    } satisfies RunArtifactsSummary;
    const res = await postFinalize(runId, {
      memories: [],
      output: { ok: true },
      logs: [],
      status: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
      artifacts,
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    // A `partial` artifacts summary coexists with a SUCCESSFUL run.
    expect(row?.status).toBe("success");
    expect(row?.artifacts).toEqual(artifacts);

    // The run DTO exposes `artifacts` snake_case (field + inner keys).
    const dto = await getRunFull({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, runId);
    expect(dto?.artifacts).toEqual(artifacts);
  });

  it("leaves runs.artifacts null when an older container omits the summary", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const res = await postFinalize(runId, {
      memories: [],
      output: { ok: true },
      logs: [],
      status: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.artifacts).toBeNull();
  });

  it("rejects a malformed artifacts summary with a 400 (Zod)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const res = await postFinalize(runId, {
      memories: [],
      output: { ok: true },
      logs: [],
      status: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
      // `status` outside the enum + `published` a string → strict schema rejects.
      artifacts: { status: "mostly", published: "two", failed: [] },
    });
    expect(res.status).toBe(400);

    // The run was NOT closed by the rejected POST.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.sinkClosedAt).toBeNull();
    expect(row?.artifacts).toBeNull();
  });

  it("persists the deprecated report aggregate for compatibility", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");
    const res = await postFinalize(runId, {
      memories: [],
      output: null,
      logs: [],
      report: "# Legacy report",
      status: "success",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.result).toEqual({ text: "# Legacy report" });
  });

  it("caps deprecated report text on a UTF-8 boundary", () => {
    expect(capUtf8Text("éé", 3)).toEqual({ text: "é", truncated: true });
    expect(capUtf8Text("éé", 4)).toEqual({ text: "éé", truncated: false });
  });

  // Regression (#run_300c5118): a cosmetic/non-essential field in the finalize
  // body must NEVER fail an already-completed run. Before the fix, a `log`
  // entry missing its `timestamp` (the built-in `log` tool over the
  // sidecar/MCP path) made the strict `RunResultSchema` reject the whole POST
  // with a 400, and the runner's HttpSink flipped a successful run to failed.
  // The schema now degrades malformed cosmetic fields instead of rejecting.
  it("tolerates malformed cosmetic fields — log without timestamp, degenerate usage/cost", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 10, output_tokens: 5 },
    });

    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 100,
      // log line with NO timestamp — the exact shape the sidecar path emitted.
      logs: [{ level: "info", message: "done" }],
      // present-but-malformed billing fields degrade to "absent" rather than 400.
      usage: { input_tokens: 7 },
      cost: -1,
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
    expect(row?.sinkClosedAt).not.toBeNull();
  });

  // Service-level Zod boundary on `result.usage` — the HTTP route already
  // drops malformed usage via `.catch(undefined)`, but `finalizeRun` is also
  // reached by non-HTTP callers (platform synthesis, in-process runners).
  // Invalid shape becomes explicit zero usage; finalize never falls back to
  // the side-channel column.
  it("service-level finalize treats malformed usage as zero terminal usage", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 50, output_tokens: 25 },
    });

    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    const result = emptyRunResult();
    result.status = "success";
    result.output = { ok: true };
    // Bypass the route schema deliberately — exercise the service boundary.
    (result as { usage?: unknown }).usage = { input_tokens: "lots", bogus: true };

    await finalizeRun({ run: run!, result });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/could not reach the LLM API/);
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("strips unknown keys from finalize usage before the runs.tokenUsage write", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", { tokenUsage: null });

    const res = await postFinalize(runId, {
      status: "success",
      output: { ok: true },
      durationMs: 10,
      usage: { input_tokens: 12, output_tokens: 3, vendor_specific: { huge: "blob" } },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    // Only the canonical TokenUsage fields land on the column.
    expect(row?.tokenUsage).toEqual({ input_tokens: 12, output_tokens: 3 });
  });

  // B2 preservation semantics: a NON-success terminal that carries no
  // runner-posted usage must keep the cumulative snapshot the
  // `appstrate.metric` side-channel wrote during the run — done atomically
  // in SQL (COALESCE in the CAS UPDATE), so a metric event racing the
  // finalize can never be clobbered by a stale JS read (review S-9).
  it("preserves the last-known metric snapshot on a non-success finalize without usage", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 50, output_tokens: 25 },
    });

    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    const result = emptyRunResult();
    result.status = "failed";
    result.error = { message: "container crashed", code: "crash" };
    // No result.usage at all — the watchdog-kill / crash shape.

    await finalizeRun({ run: run!, result });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.sinkClosedAt).not.toBeNull();
    // The side-channel snapshot survives — never masked by zeros.
    expect(row?.tokenUsage).toEqual({ input_tokens: 50, output_tokens: 25 });
  });

  it("malformed usage on a NON-success finalize also preserves the snapshot (B2)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 7, output_tokens: 2 },
    });

    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    const result = emptyRunResult();
    result.status = "failed";
    result.error = { message: "boom", code: "crash" };
    // Bypass the route schema deliberately — exercise the service boundary.
    (result as { usage?: unknown }).usage = { input_tokens: "lots", bogus: true };

    await finalizeRun({ run: run!, result });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.tokenUsage).toEqual({ input_tokens: 7, output_tokens: 2 });
  });

  it("zero-fills a non-success finalize when NO usage was ever recorded", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", { tokenUsage: null });

    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    const result = emptyRunResult();
    result.status = "failed";
    result.error = { message: "died at boot", code: "crash" };

    await finalizeRun({ run: run!, result });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.tokenUsage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("does not throw on a corrupt tokenUsage JSONB during a non-success finalize", async () => {
    // readLastKnownUsage's tolerant Zod boundary: a corrupt column value
    // degrades to null for the ledger fallback, and the finalize still
    // closes the run — never a crash mid-terminal-transition.
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: "corrupt" } as unknown as Record<string, number>,
    });

    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    const result = emptyRunResult();
    result.status = "failed";
    result.error = { message: "boom", code: "crash" };

    await finalizeRun({ run: run!, result });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.sinkClosedAt).not.toBeNull();
  });

  // Zod boundary on `runs.result` (runResultSchema, 512 KiB cap): an
  // over-cap payload degrades to `result: null` + a warn log — it must
  // never fail the terminal transition of an already-completed run.
  it("drops an oversized result payload without failing the finalize", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const res = await postFinalize(runId, {
      status: "success",
      output: { blob: "x".repeat(600 * 1024) },
      durationMs: 5,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.sinkClosedAt).not.toBeNull();
    expect(row?.result).toBeNull();
  });

  it("does not let a compatibility report evict an otherwise valid structured output", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");
    const output = { blob: "x".repeat(300 * 1024) };

    const res = await postFinalize(runId, {
      status: "success",
      output,
      report: "r".repeat(256 * 1024),
      durationMs: 5,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.result).toEqual({ output });
  });

  it("idempotent — once the sink is closed, further finalize POSTs reject with 410", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const first = {
      status: "success",
      output: { v: 1 },
      durationMs: 10,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const second = {
      status: "success",
      output: { v: 2 },
      durationMs: 20,
      usage: { input_tokens: 20, output_tokens: 10 },
    };

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

    const body = {
      status: "success",
      output: { v: 1 },
      durationMs: 10,
      usage: { input_tokens: 10, output_tokens: 5 },
    };

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

  it("does not fall back to runs.tokenUsage when result.usage is absent on a success terminal", async () => {
    // On a SUCCESS terminal the finalize body is authoritative. A side-channel
    // metric may have populated the column, but absence from finalize is
    // treated as explicit zero usage and overwrites the column — this keeps
    // the zero-token liveness heuristic honest. (Non-success terminals
    // preserve the column instead — see the killed-run tests below.)
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
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/could not reach the LLM API/);
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  it("flips to failed when result.usage is absent and no prior metric exists", async () => {
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
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 0, output_tokens: 0 });
  });

  // ---------------------------------------------------------------------
  // Authoritative runner status (issue: run_fd977eb6). Terminal
  // success/failure is the RUNNER's call — `PiRunner.run()` inspects the
  // settled session and stamps `status`/`error` (see runner-pi's bridge
  // `getTerminalError()`). The platform TRUSTS that status and must NOT
  // re-derive it from the `run_logs` adapter-error trail. The old
  // server-side "adapter-error backstop" (#427) did that archaeology and
  // produced false positives: it failed runs whose agent recovered from a
  // transient mid-loop error and finished without structured output (which
  // legitimately leaves `output === null`). These tests pin that the trail
  // never flips a runner-declared `success`.
  // ---------------------------------------------------------------------
  it("trusts a runner-declared failure (status=failed) over inference", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const res = await postFinalize(runId, {
      status: "failed",
      error: { code: "adapter_error", message: "Codex error: server_error" },
      durationMs: 100,
      usage: { input_tokens: 5_000, output_tokens: 1_423 },
      // No `output` — the agent's final turn ended in an error.
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/server_error/);
  });

  it("preserves success when output is null and no error is declared", async () => {
    // An agent that legitimately has no output schema (a side-effect run)
    // finalizes with output=null and status=success. The platform must not
    // invent a failure.
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    const res = await postFinalize(runId, {
      status: "success",
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
      // No `output`, no `error`.
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
  });

  it("does NOT flip success → failed from an adapter_error trail when the runner recovered", async () => {
    // Regression for run_fd977eb6 — a transient OpenAI 5xx `server_error`
    // left an `adapter_error` row, but the agent recovered, finished its
    // work, and the runner declared `status: success` (output null because
    // it produced no structured output). The trail must NOT override that.
    const runId = await seedRunWithSink(ctx, "@test/final-agent");

    await db.insert(runLogs).values({
      runId,
      orgId: ctx.orgId,
      type: "system",
      event: "adapter_error",
      message: 'Codex error: {"error":{"type":"server_error","code":"server_error"}}',
      level: "error",
    });

    const res = await postFinalize(runId, {
      status: "success",
      durationMs: 100,
      usage: { input_tokens: 5_000, output_tokens: 1_423 },
      // No `output` — a side-effect run; runner already declared success.
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
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
      usage: { input_tokens: 300, output_tokens: 125 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.cost).toBeCloseTo(0.003, 5);
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 300, output_tokens: 125 });
  });

  // ---------------------------------------------------------------------
  // Killed-run usage preservation — a run that dies without posting a
  // terminal `result.usage` (watchdog kill, container crash, runner-declared
  // failure with no billing block) must NOT have its recorded spend erased
  // at finalize. The per-call usage already flowed through the platform
  // during the run (`appstrate.metric` → runner ledger row + the
  // `runs.tokenUsage` snapshot); the "absent usage = explicit zero" rule
  // only applies to success terminals, where it feeds the zero-token
  // liveness heuristic. Pre-fix, the zero-token terminal path overwrote
  // the snapshot with `{0, 0}` on every kill path.
  // ---------------------------------------------------------------------
  it("preserves last-known metric usage and ledger cost when a failed finalize carries no usage", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", { tokenUsage: null });

    // Live metric event during the run — writes the runner-source ledger
    // row AND the runs.tokenUsage running-total snapshot.
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

    // Runner dies mid-flight: the terminal POST carries a failure and no
    // usage/cost fields (the billing block is assembled last).
    const res = await postFinalize(runId, {
      status: "failed",
      error: { message: "container killed" },
      durationMs: 100,
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    // Snapshot preserved — not masked by a zero-token terminal write.
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 300, output_tokens: 125 });
    // Cost captured from the ledger row the metric event wrote.
    expect(row?.cost).toBeCloseTo(0.003, 5);

    // Exactly one runner-source ledger row — preservation writes nothing,
    // so there is no double count.
    const ledger = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.costUsd).toBeCloseTo(0.003, 5);
    expect(ledger[0]!.inputTokens).toBe(300);
    expect(ledger[0]!.outputTokens).toBe(125);
  });

  it("captures usage and cost for a watchdog-style kill (service-level finalize without result.usage)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/final-agent", { tokenUsage: null });

    const ev = buildEnvelope(
      runId,
      "appstrate.metric",
      {
        usage: { input_tokens: 450, output_tokens: 60 },
        cost: 0.0071,
        timestamp: Date.now(),
      },
      1,
    );
    expect((await postEvent(runId, ev)).status).toBe(200);

    // Mirror `finalizeStalledRun` (run-watchdog.ts): the platform
    // synthesises a bare failed RunResult with NO usage reconstruction —
    // finalizeRun itself must fall back to the metric snapshot.
    const run = await getRunSinkContext(runId);
    expect(run).not.toBeNull();
    const result = emptyRunResult();
    result.status = "failed";
    result.error = { message: "Runner stopped reporting — no heartbeat for 60s." };
    await finalizeRun({ run: run!, result });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 450, output_tokens: 60 });
    expect(row?.cost).toBeCloseTo(0.0071, 5);
  });

  it("terminal result.usage stays authoritative on a failed finalize — preservation only fills absence", async () => {
    // Guard direction: when the dying runner DID post terminal usage with
    // its failure, the body wins over the column snapshot exactly as on the
    // success path — the fallback never overrides an explicit value.
    const runId = await seedRunWithSink(ctx, "@test/final-agent", {
      tokenUsage: { input_tokens: 999, output_tokens: 999 },
    });

    const res = await postFinalize(runId, {
      status: "failed",
      error: { message: "adapter blew up after the last turn" },
      durationMs: 100,
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.tokenUsage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });
});

// ---------------------------------------------------------------------------
// `afterRun` hook contract — finalize MUST forward `runs.modelSource` so
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
      redisUrl: null,
      appUrl: "http://localhost:3000",
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

// ---------------------------------------------------------------------------
// Remote-origin `run.started` timing (finding #26). Remote runs no longer
// emit `started` at row-insert time (run-creation.ts) — that fired before
// the DB transitioned and never fired again when it actually happened.
// The `onRunStatusChange { status: "started" }` event now fires from
// `persistEventAndAdvance` at the moment the row flips pending → running
// (first ingested event). Platform-origin runs still emit from
// `executeAgentInBackground` and must NOT double-emit here.
// ---------------------------------------------------------------------------
describe("remote run.started — emitted at first event, not at row insert", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    resetModules();
    ctx = await createTestContext({ email: "started@test.dev", orgSlug: "started-org" });
    await seedPackage({ orgId: ctx.orgId, id: "@test/started-agent", type: "agent" });
  });

  afterAll(() => {
    resetModules();
  });

  async function captureStartedEvents(): Promise<{
    started: () => RunStatusChangeParams[];
  }> {
    const seen: RunStatusChangeParams[] = [];
    const mod: AppstrateModule = {
      manifest: { id: "started-spy", name: "Started Spy", version: "1.0.0" },
      async init() {},
      events: {
        onRunStatusChange: async (params) => {
          if (params.status === "started") seen.push(params);
        },
      },
    };
    await loadModulesFromInstances([mod], {
      redisUrl: null,
      appUrl: "http://localhost:3000",
      getSendMail: async () => () => {},
      getOrgAdminEmails: async () => [],
      services: {} as never,
    });
    return { started: () => seen };
  }

  async function seedPendingRemoteRun(): Promise<string> {
    const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await db.insert(runs).values({
      id: runId,
      packageId: "@test/started-agent",
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      status: "pending",
      runOrigin: "remote",
      sinkSecretEncrypted: encrypt(RUN_SECRET),
      sinkExpiresAt: new Date(Date.now() + 3600_000),
      startedAt: new Date(),
      tokenUsage: { input_tokens: 100, output_tokens: 50 } as unknown as Record<string, number>,
    });
    return runId;
  }

  it("does not fire run.started for a remote run until the first event is ingested", async () => {
    const { started } = await captureStartedEvents();
    const runId = await seedPendingRemoteRun();

    // No event yet — the row was created `pending`; nothing should have
    // emitted `started` (the old insert-time emit is gone).
    await new Promise((r) => setTimeout(r, 0));
    expect(started()).toHaveLength(0);

    // First signed event arrives → DB flips pending → running.
    const envelope = buildEnvelope(
      runId,
      "appstrate.progress",
      { message: "first", timestamp: Date.now() },
      1,
    );
    const res = await postEvent(runId, envelope);
    expect(res.status).toBe(200);

    // emitEvent is fire-and-forget — let the microtask/timer queue drain.
    await new Promise((r) => setTimeout(r, 0));

    const events = started();
    expect(events).toHaveLength(1);
    expect(events[0]!.runId).toBe(runId);
    expect(events[0]!.status).toBe("started");

    // And the row actually transitioned to running.
    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("running");
  });

  it("emits run.started only once across subsequent events", async () => {
    const { started } = await captureStartedEvents();
    const runId = await seedPendingRemoteRun();

    for (const seq of [1, 2, 3]) {
      const res = await postEvent(
        runId,
        buildEnvelope(
          runId,
          "appstrate.progress",
          { message: `e${seq}`, timestamp: Date.now() },
          seq,
        ),
      );
      expect(res.status).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 0));

    expect(started()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Output-schema validation at finalize — declared via `manifest.output.schema`
// (AFPS). A mismatch flips the run to failed with the validation errors on
// `runs.error`, but the payload is still persisted on `runs.result` — the
// deliverable is flagged, never dropped.
// ---------------------------------------------------------------------------
describe("POST /api/runs/:runId/events/finalize — output-schema validation persistence", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ email: "outschema632@test.dev", orgSlug: "outschema632-org" });
    await seedPackage({
      orgId: ctx.orgId,
      id: "@test/schema-agent",
      type: "agent",
      draftManifest: {
        name: "@test/schema-agent",
        version: "0.1.0",
        type: "agent",
        description: "Agent with a declared output schema",
        runtime_tools: ["output"],
        output: {
          schema: {
            type: "object",
            required: ["answer"],
            additionalProperties: false,
            properties: { answer: { type: "string" } },
          },
        },
      },
    });
  });

  it("schema-conforming output stays success and is persisted", async () => {
    const runId = await seedRunWithSink(ctx, "@test/schema-agent");

    const res = await postFinalize(runId, {
      status: "success",
      output: { answer: "42" },
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
    expect((row?.result as { output?: unknown } | null)?.output).toEqual({ answer: "42" });
  });

  it("schema mismatch flips to failed but still persists the payload (flag, don't drop)", async () => {
    const runId = await seedRunWithSink(ctx, "@test/schema-agent");

    const res = await postFinalize(runId, {
      status: "success",
      output: { wrong: 1 },
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/Output validation failed/);
    const persisted = row?.result as { output?: unknown } | null;
    // The non-conforming payload is stored, flagged via status + error.
    expect(persisted?.output).toEqual({ wrong: 1 });

    // The validation failure also leaves its structured trail in run_logs.
    const validationLogs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.event, "output_validation")));
    expect(validationLogs).toHaveLength(1);
  });

  it("output tool never called fails with a tool-not-called message, not a bare validation error", async () => {
    const runId = await seedRunWithSink(ctx, "@test/schema-agent");

    // Agent never emitted structured output (`result.output` stays null). The
    // empty `{}` only fails because `answer` is required — the error must say
    // the tool was never called, not imply a malformed payload.
    const res = await postFinalize(runId, {
      status: "success",
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/without calling the required `output` tool/);
    expect(row?.error).not.toMatch(/^Output validation failed/);
  });

  it("a platform-SYNTHESISED success still gets the `output` tool wording when the schema was unmet", async () => {
    // Lost finalize POST + container exit 0: execute-background synthesises
    // success. Every run delivers structured output through the single `output`
    // runtime tool, so an unmet schema fails with that tool's wording.
    const runId = await seedRunWithSink(ctx, "@test/schema-agent");

    await synthesiseFinalize(runId, {
      status: "success",
      durationMs: 100,
    });

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/without calling the required `output` tool/);
  });

  // ── Version-pinned runs: finalize validates against the manifest the run
  //    EXECUTED (`runs.version_ref` → `package_versions` snapshot), never the
  //    mutable draft. A post-kickoff draft edit must not flip a pinned run's
  //    outcome in either direction.

  it("pinned run: a draft schema tightened AFTER publish does not fail a run valid per its pinned manifest", async () => {
    // Published 1.0.0 has NO output schema; the draft (seeded in beforeEach)
    // requires `answer`. A run pinned to 1.0.0 finishing without output must
    // stay success — validating against the draft would flip it to failed.
    await seedPackageVersion({
      packageId: "@test/schema-agent",
      version: "1.0.0",
      manifest: {
        name: "@test/schema-agent",
        version: "1.0.0",
        type: "agent",
        runtime_tools: ["report"],
      },
    });
    const runId = await seedRunWithSink(ctx, "@test/schema-agent", { versionRef: "1.0.0" });

    const res = await postFinalize(runId, {
      status: "success",
      report: "No structured output — the pinned version declares no schema.",
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("success");
    expect(row?.error).toBeNull();
  });

  it("pinned run: the pinned manifest's schema IS enforced even when the draft dropped it", async () => {
    // Published 2.0.0 requires `answer`; replace the draft with one declaring
    // NO output schema. A run pinned to 2.0.0 finishing without output must
    // fail — validating against the draft would let it pass.
    await seedPackageVersion({
      packageId: "@test/schema-agent",
      version: "2.0.0",
      manifest: {
        name: "@test/schema-agent",
        version: "2.0.0",
        type: "agent",
        runtime_tools: ["output", "report"],
        output: {
          schema: {
            type: "object",
            required: ["answer"],
            additionalProperties: false,
            properties: { answer: { type: "string" } },
          },
        },
      },
    });
    await db
      .update(packages)
      .set({
        draftManifest: {
          name: "@test/schema-agent",
          version: "2.0.1",
          type: "agent",
          runtime_tools: ["report"],
        },
      })
      .where(eq(packages.id, "@test/schema-agent"));
    const runId = await seedRunWithSink(ctx, "@test/schema-agent", { versionRef: "2.0.0" });

    const res = await postFinalize(runId, {
      status: "success",
      report: "Forgot to call output.",
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/without calling the required `output` tool/);
  });

  it("pinned run whose version row is gone falls back to the draft schema", async () => {
    // `version_ref` names a version that was deleted after kickoff — the
    // helper degrades to the draft (which requires `answer`), preserving the
    // pre-fix behavior instead of skipping validation entirely.
    const runId = await seedRunWithSink(ctx, "@test/schema-agent", { versionRef: "9.9.9" });

    const res = await postFinalize(runId, {
      status: "success",
      report: "No output.",
      durationMs: 100,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/without calling the required `output` tool/);
  });
});
