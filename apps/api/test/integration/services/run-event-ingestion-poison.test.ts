// SPDX-License-Identifier: Apache-2.0

/**
 * #1501 regression — a runner value Postgres rejects must not wedge a run's
 * event stream.
 *
 *   - Sanitisation at the write: NUL bytes / lone surrogates in a run_logs
 *     row (`data` jsonb or `message` text — `appendRunLog`, whoever calls it)
 *     or in the finalize body are stored as U+FFFD instead of failing the
 *     write with SQLSTATE 22P05 / 22021.
 *   - Placeholder path: when a write still fails with a data exception (class
 *     22, determined by the row's own values, so a retry replays it
 *     identically — class 22, or a CHECK violation 23514), the sequence is
 *     claimed with a `system/event_dropped` warn row and the drop is logged
 *     once at error level — on the fast path, on the buffer drain, and on
 *     finalize's gap-tolerant drain. Any other failure (transient, 23505,
 *     23502) still rolls back: 5xx, the runner retries.
 *   - `appstrate.metric`: token counts past int4 / fractional are clamped into
 *     the `llm_usage` ledger; a negative `cost` is ignored.
 *
 * The row-value failure is forced with `failRunLogsInsert` (a real
 * `BEFORE INSERT` trigger raising a chosen SQLSTATE for a marker message), so
 * it stays a genuine Postgres error travelling through Drizzle (no
 * process-global module mock) that the sanitiser cannot neutralise.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { runs, runLogs, llmUsage, packagePersistence } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import { sign } from "@appstrate/afps-runtime/events";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { failRunLogsInsert, clearRunLogsFault } from "../../helpers/run-logs-fault.ts";
import { logger } from "../../../src/lib/logger.ts";
import { appendRunLog } from "../../../src/services/state/runs.ts";

const app = getTestApp();

const AGENT = "@poisonorg/poison-agent";
const RUN_SECRET = "c".repeat(43);
const POISON = "__poison__";
/** The one error-level line a dropped event produces (exact match — other lines say "dropped"). */
const DROP_LOG = "run event could not be stored and was dropped";
const INT4_MAX = 2_147_483_647;
const FFFD = "\uFFFD";

// --- harness -----------------------------------------------------------------

function signedHeaders(body: string) {
  const headers = sign({
    msgId: `msg_${crypto.randomUUID()}`,
    timestampSec: Math.floor(Date.now() / 1000),
    body,
    secret: RUN_SECRET,
  });
  return {
    "Content-Type": "application/json",
    "webhook-id": headers["webhook-id"],
    "webhook-timestamp": headers["webhook-timestamp"],
    "webhook-signature": headers["webhook-signature"],
  };
}

async function seedRun(
  ctx: TestContext,
  {
    runOrigin = "platform",
    status = "running",
    modelSource = null,
    modelCost = null,
  }: {
    runOrigin?: "platform" | "remote";
    status?: "pending" | "running";
    modelSource?: string | null;
    modelCost?: { input: number; output: number } | null;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId: AGENT,
    orgId: ctx.orgId,
    spaceId: ctx.defaultSpaceId,
    status,
    runOrigin,
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
    // Non-zero usage so finalize's zero-tokens heuristic keeps `success`.
    tokenUsage: { input_tokens: 100, output_tokens: 50 },
    modelSource,
    modelCost,
  });
  return runId;
}

function post(path: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return Promise.resolve(app.request(path, { method: "POST", headers: signedHeaders(body), body }));
}

/** POST one signed event; `data` is the envelope's event payload. */
function postEvent(runId: string, sequence: number, type: string, data: Record<string, unknown>) {
  return post(`/api/runs/${runId}/events`, {
    specversion: "1.0",
    type,
    source: `/afps/runs/${runId}`,
    id: `msg_${crypto.randomUUID()}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    data,
    sequence,
  });
}

const postProgress = (runId: string, sequence: number, data: Record<string, unknown>) =>
  postEvent(runId, sequence, "appstrate.progress", data);

const clean = (message: string) => ({ message });

async function expectOutcome(res: Response, outcome: "persisted" | "buffered") {
  expect(res.status).toBe(200);
  expect(((await res.json()) as { outcome: string }).outcome).toBe(outcome);
}

function postFinalize(runId: string, result: Record<string, unknown>) {
  return post(`/api/runs/${runId}/events/finalize`, {
    status: "success",
    durationMs: 100,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...result,
  });
}

async function readRun(runId: string) {
  const [row] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return row!;
}

function readLogs(runId: string) {
  return db.select().from(runLogs).where(eq(runLogs.runId, runId)).orderBy(asc(runLogs.id));
}

/** Make every `run_logs` INSERT of the {@link POISON} message fail with `sqlState`. */
const poisonRunLogs = (sqlState: string) => failRunLogsInsert(POISON, sqlState);

/** The progress messages in sequence order, with placeholders shown as `<dropped>`. */
function timeline(logs: Awaited<ReturnType<typeof readLogs>>): (string | null)[] {
  return logs.map((l) => (l.event === "event_dropped" ? "<dropped>" : l.message));
}

function expectPlaceholder(
  logs: Awaited<ReturnType<typeof readLogs>>,
  sequence: number,
  sqlState: string,
) {
  const dropped = logs.filter((l) => l.event === "event_dropped");
  expect(dropped).toHaveLength(1);
  expect(dropped[0]).toMatchObject({ type: "system", level: "warn" });
  expect(dropped[0]!.message).toContain('"appstrate.progress"');
  expect(dropped[0]!.message).toContain(`#${sequence}`);
  expect(dropped[0]!.message).toContain(sqlState);
}

// --- tests -------------------------------------------------------------------

describe("run event ingestion — Postgres-poisoned values (#1501)", () => {
  let ctx: TestContext;
  let warn: Mock<typeof logger.warn>;
  let error: Mock<typeof logger.error>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "poisonorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
    warn = spyOn(logger, "warn");
    error = spyOn(logger, "error");
  });

  afterEach(async () => {
    warn.mockRestore();
    error.mockRestore();
    await clearRunLogsFault();
  });

  const dropLogs = () => error.mock.calls.filter((c) => c[0] === DROP_LOG);

  describe("sanitisation at the write", () => {
    it("stores a NUL / lone surrogate in event data as U+FFFD and keeps the stream moving", async () => {
      const runId = await seedRun(ctx);

      await expectOutcome(
        await postProgress(runId, 1, {
          message: "step",
          data: { text: "a\u0000b", note: "x\uD800y", ["k\u0000"]: "v" },
        }),
        "persisted",
      );
      await expectOutcome(await postProgress(runId, 2, clean("two")), "persisted");
      await expectOutcome(await postProgress(runId, 3, clean("three")), "persisted");

      expect((await readRun(runId)).lastEventSequence).toBe(3);
      const logs = await readLogs(runId);
      expect(timeline(logs)).toEqual(["step", "two", "three"]);
      expect(logs[0]!.data).toEqual({
        text: `a${FFFD}b`,
        note: `x${FFFD}y`,
        [`k${FFFD}`]: "v",
      });
      expect(error).not.toHaveBeenCalled();
    });

    it("stores a NUL in the message (text column) as U+FFFD", async () => {
      const runId = await seedRun(ctx);

      await expectOutcome(await postProgress(runId, 1, clean("a\u0000b\uDC00")), "persisted");
      await expectOutcome(await postProgress(runId, 2, clean("two")), "persisted");
      await expectOutcome(await postProgress(runId, 3, clean("three")), "persisted");

      expect((await readRun(runId)).lastEventSequence).toBe(3);
      expect(timeline(await readLogs(runId))).toEqual([`a${FFFD}b${FFFD}`, "two", "three"]);
      expect(error).not.toHaveBeenCalled();
    });

    it("sanitises a direct appendRunLog call, outside event ingestion", async () => {
      const runId = await seedRun(ctx);

      await appendRunLog(
        { orgId: ctx.orgId },
        runId,
        "system",
        "firecracker_console",
        "console\u0000tail",
        { text: "a\u0000b" },
        "error",
      );

      const [log] = await readLogs(runId);
      expect(log!.message).toBe(`console${FFFD}tail`);
      expect(log!.data).toEqual({ text: `a${FFFD}b` });
    });

    it("stores a memory whose trim splits a surrogate pair, the half replaced", async () => {
      const runId = await seedRun(ctx);

      const res = await postFinalize(runId, {
        status: "success",
        memories: [{ content: `${"a".repeat(1999)}😀` }],
      });
      expect(res.status).toBe(200);

      const memories = await db
        .select()
        .from(packagePersistence)
        .where(eq(packagePersistence.runId, runId));
      expect(memories).toHaveLength(1);
      expect(memories[0]!.content).toBe(`${"a".repeat(1999)}${FFFD}`);
    });

    it("drains a buffered successor behind a poisoned event that arrives late", async () => {
      const runId = await seedRun(ctx);

      await expectOutcome(await postProgress(runId, 2, clean("two")), "buffered");
      await expectOutcome(
        await postProgress(runId, 1, { message: "one\u0000", data: { text: "a\u0000b" } }),
        "persisted",
      );
      await expectOutcome(await postProgress(runId, 3, clean("three")), "persisted");

      expect((await readRun(runId)).lastEventSequence).toBe(3);
      expect(timeline(await readLogs(runId))).toEqual([`one${FFFD}`, "two", "three"]);
    });

    it("stores a NUL in the finalize body's output and error sanitised", async () => {
      const runId = await seedRun(ctx);

      const res = await postFinalize(runId, {
        status: "failed",
        output: { text: "out\u0000put", ["k\uD800"]: 1 },
        error: { message: "boom\u0000!" },
      });
      expect(res.status).toBe(200);

      const row = await readRun(runId);
      expect(row.status).toBe("failed");
      expect(row.sinkClosedAt).not.toBeNull();
      expect(row.error).toBe(`boom${FFFD}!`);
      expect((row.result as { output?: unknown }).output).toEqual({
        text: `out${FFFD}put`,
        [`k${FFFD}`]: 1,
      });
    });
  });

  describe("row-value failure after sanitisation → placeholder row", () => {
    const SQLSTATE = "22P05";

    // 22xxx data exception, 23514 CHECK violation: both determined by the row's
    // own values, so a retry would replay the failure identically.
    it.each(["22P05", "23514"])(
      "claims the sequence with an event_dropped row (%s)",
      async (sqlState) => {
        const runId = await seedRun(ctx);
        await poisonRunLogs(sqlState);

        await expectOutcome(await postProgress(runId, 1, clean("one")), "persisted");
        await expectOutcome(await postProgress(runId, 2, clean(POISON)), "persisted");
        expect((await readRun(runId)).lastEventSequence).toBe(2);
        await expectOutcome(await postProgress(runId, 3, clean("three")), "persisted");

        expect((await readRun(runId)).lastEventSequence).toBe(3);
        const logs = await readLogs(runId);
        expect(timeline(logs)).toEqual(["one", "<dropped>", "three"]);
        expectPlaceholder(logs, 2, sqlState);
        expect(dropLogs()).toHaveLength(1);
      },
    );

    it("a poisoned FIRST event still flips a pending run to running", async () => {
      const runId = await seedRun(ctx, { status: "pending" });
      await poisonRunLogs(SQLSTATE);

      await expectOutcome(await postProgress(runId, 1, clean(POISON)), "persisted");

      const row = await readRun(runId);
      expect(row.lastEventSequence).toBe(1);
      expect(row.status).toBe("running");
      const logs = await readLogs(runId);
      expect(timeline(logs)).toEqual(["<dropped>"]);
      expectPlaceholder(logs, 1, SQLSTATE);
      expect(dropLogs()).toHaveLength(1);
    });

    it("drops a buffered poisoned event without failing the POST that drains it", async () => {
      const runId = await seedRun(ctx);
      await poisonRunLogs(SQLSTATE);

      await expectOutcome(await postProgress(runId, 3, clean("three")), "buffered");
      await expectOutcome(await postProgress(runId, 2, clean(POISON)), "buffered");
      // seq 1 persists, then its drain meets the poisoned head: still 200.
      await expectOutcome(await postProgress(runId, 1, clean("one")), "persisted");

      expect((await readRun(runId)).lastEventSequence).toBe(3);
      const logs = await readLogs(runId);
      expect(timeline(logs)).toEqual(["one", "<dropped>", "three"]);
      expectPlaceholder(logs, 2, SQLSTATE);
    });

    it("finalize drains a buffered poisoned event and terminates the run", async () => {
      const runId = await seedRun(ctx);
      await poisonRunLogs(SQLSTATE);

      await expectOutcome(await postProgress(runId, 1, clean("one")), "persisted");
      // seq 2 never arrives: the poisoned seq 3 stays buffered behind the gap.
      await expectOutcome(await postProgress(runId, 3, clean(POISON)), "buffered");

      expect((await postFinalize(runId, {})).status).toBe(200);

      const row = await readRun(runId);
      expect(row.status).toBe("success");
      expect(row.sinkClosedAt).not.toBeNull();
      expect(row.lastEventSequence).toBe(3);
      const logs = await readLogs(runId);
      expect(
        timeline(logs.filter((l) => l.type !== "system" || l.event === "event_dropped")),
      ).toEqual(["one", "<dropped>"]);
      expectPlaceholder(logs, 3, SQLSTATE);
    });

    // 08006 connection failure (transient), 23505 unique violation (depends on
    // OTHER rows, so a retry can succeed), 23502 NOT NULL (not classified as a
    // row-value error): the runner must retry, not drop.
    it.each(["08006", "23505", "23502"])(
      "%s still rolls back: 5xx, sequence not advanced",
      async (code) => {
        const runId = await seedRun(ctx);
        await poisonRunLogs(code);

        const res = await postProgress(runId, 1, clean(POISON));
        expect(res.status).toBeGreaterThanOrEqual(500);

        expect((await readRun(runId)).lastEventSequence).toBe(0);
        expect(await readLogs(runId)).toHaveLength(0);
        expect(dropLogs()).toHaveLength(0);
      },
    );
  });

  describe("appstrate.metric values the ledger cannot store", () => {
    const readRunnerLedger = (runId: string) =>
      db
        .select()
        .from(llmUsage)
        .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));

    const ignoredWarnings = () =>
      warn.mock.calls.filter((c) => String(c[0]).includes("invalid field ignored"));

    it("clamps token counts past int4 / fractional into the ledger — 200, no warning", async () => {
      const runId = await seedRun(ctx);

      await expectOutcome(
        await postEvent(runId, 1, "appstrate.metric", {
          usage: { input_tokens: 3e9, output_tokens: 1.5 },
        }),
        "persisted",
      );

      const row = await readRun(runId);
      expect(row.lastEventSequence).toBe(1);
      // The run row keeps the reported snapshot as-is (jsonb holds any number).
      expect(row.tokenUsage).toEqual({ input_tokens: 3e9, output_tokens: 1.5 });
      const ledger = await readRunnerLedger(runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ inputTokens: INT4_MAX, outputTokens: 1 });
      expect(ignoredWarnings()).toHaveLength(0);
      expect(dropLogs()).toHaveLength(0);
    });

    // Each column fits int4 but the row's token SUM does not: the monotonic
    // upsert's comparison must not overflow (22003) on the second snapshot.
    it("advances the runner row across snapshots whose token sum exceeds int4", async () => {
      const runId = await seedRun(ctx);
      const snapshot = (sequence: number, input: number, cacheRead: number) =>
        postEvent(runId, sequence, "appstrate.metric", {
          usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead },
        });

      await expectOutcome(await snapshot(1, 2_000_000_000, 500_000_000), "persisted");
      await expectOutcome(await snapshot(2, 3_000_000_000, 600_000_000), "persisted");

      expect((await readRun(runId)).lastEventSequence).toBe(2);
      const ledger = await readRunnerLedger(runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        inputTokens: INT4_MAX, // 3e9 clamped per column
        outputTokens: 1,
        cacheReadTokens: 600_000_000,
      });
      expect((await readLogs(runId)).filter((l) => l.event === "event_dropped")).toHaveLength(0);
      expect(dropLogs()).toHaveLength(0);
    });

    it("prices a platform run from the capped counts it stores (tokens × rate = cost)", async () => {
      const runId = await seedRun(ctx, {
        modelSource: "system",
        modelCost: { input: 3, output: 15 },
      });

      await expectOutcome(
        await postEvent(runId, 1, "appstrate.metric", { usage: { input_tokens: 1e18 } }),
        "persisted",
      );

      const [row] = await readRunnerLedger(runId);
      expect(row).toMatchObject({ inputTokens: INT4_MAX, outputTokens: 0 });
      expect(row!.costUsd).toBeCloseTo((INT4_MAX * 3) / 1e6, 6);
      expect(dropLogs()).toHaveLength(0);
    });

    it("ignores a negative cost on a remote run — 200, usage kept, cost not recorded", async () => {
      const runId = await seedRun(ctx, { runOrigin: "remote" });

      await expectOutcome(
        await postEvent(runId, 1, "appstrate.metric", {
          usage: { input_tokens: 10, output_tokens: 5 },
          cost: -1,
        }),
        "persisted",
      );

      const row = await readRun(runId);
      expect(row.lastEventSequence).toBe(1);
      expect(row.tokenUsage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
      const ledger = await readRunnerLedger(runId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]!.costUsd).toBe(0);
      expect(ignoredWarnings()).toHaveLength(1);
      expect(dropLogs()).toHaveLength(0);
    });
  });
});
