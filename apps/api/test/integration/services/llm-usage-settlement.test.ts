// SPDX-License-Identifier: Apache-2.0

/**
 * Settlement invariants of the `llm_usage` ledger — the boundary where a
 * runner row stops being writable and becomes billable.
 *
 * A runner row is ONE cumulative row per run whose `cost_usd` grows during the
 * run. A billing cursor claims it by serial id the instant it is `settled`
 * (= its run reached a terminal status) and NEVER revisits that id. Three
 * things must therefore hold, and each is asserted here end-to-end:
 *
 *   1. TERMINAL BARRIER — `finalizeRun` makes the run's cumulative snapshot
 *      durable BEFORE the CAS that settles it, on every path, including the
 *      platform-synthesised terminals that carry no `result.cost`
 *      (stall watchdog, boot orphan sweep, container crash);
 *   2. POST-SETTLEMENT IMMUTABILITY — a snapshot arriving after the run went
 *      terminal (a durable-retry replay, a losing concurrent finalize) is
 *      REFUSED, not silently applied to a row someone already billed;
 *   2b. AND THE REFUSAL IS REPORTED WITH A SIGNAL-TO-NOISE RATIO OF 1 — a
 *      refusal that loses billable spend emits exactly one `logger.error`
 *      carrying the two cumulative totals and the delta nobody will bill; a
 *      refusal that loses NOTHING is silent. The distinction is the whole
 *      point: `run-launcher/execute-background.ts` synthesises a finalize on
 *      EVERY clean container exit, so every successful run replays its own
 *      last snapshot at `costUsd: 0` after settling. A status-only test drowned
 *      the real losses under one error per run (issue #997). Both halves are
 *      asserted below — the noise floor as well as the alarm;
 *   3. NO DURABLE QUEUE FOR RUNNER ROWS — a failed runner write propagates
 *      instead of being deferred, because a deferred replay could only land
 *      after settlement, where (2) refuses it.
 *
 * Plus the read-side rule that keeps a remote run from being counted twice:
 * the runner MIRROR of a proxy-metered run is excluded from the module-facing
 * cursor read, not merely documented for consumers.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { llmUsage, runs } from "@appstrate/db/schema";
import { encrypt } from "@appstrate/connect";
import type { Db } from "@appstrate/db/client";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { logger } from "../../../src/lib/logger.ts";
import { recordLlmUsage } from "../../../src/services/llm-usage-ledger.ts";
import {
  recordLlmUsageReliably,
  initLlmUsageRetryWorker,
  _resetLlmUsageRetryWorkerForTests,
} from "../../../src/services/llm-usage-retry.ts";
import {
  getRunSinkContext,
  finalizeRun,
  synthesiseFinalize,
} from "../../../src/services/run-event-ingestion.ts";
import {
  computeRunCost,
  listLlmUsage,
  getSettledFrontierId,
} from "../../../src/services/state/runs.ts";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";

const AGENT = "@settleorg/settle-agent";
const RUN_SECRET = "c".repeat(43);

/**
 * Poll `read` until it returns a defined value. Used to observe a queue worker's
 * effect, which is inherently asynchronous. Bounded by an ATTEMPT COUNT rather
 * than a wall-clock deadline, so a slow CI box cannot turn a pass into a flake;
 * returns undefined on exhaustion and lets the caller's assertion report it.
 */
async function waitFor<T>(
  read: () => Promise<T | undefined>,
  attempts = 60,
): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

async function seedSinkRun(
  ctx: TestContext,
  overrides: {
    modelSource?: string | null;
    runOrigin?: "platform" | "remote";
    tokenUsage?: Record<string, number> | null;
  } = {},
): Promise<string> {
  const runId = `run_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(runs).values({
    id: runId,
    packageId: AGENT,
    orgId: ctx.orgId,
    applicationId: ctx.defaultAppId,
    status: "running",
    runOrigin: overrides.runOrigin ?? "platform",
    modelSource: overrides.modelSource ?? "system",
    sinkSecretEncrypted: encrypt(RUN_SECRET),
    sinkExpiresAt: new Date(Date.now() + 3600_000),
    startedAt: new Date(),
    ...(overrides.tokenUsage !== undefined ? { tokenUsage: overrides.tokenUsage } : {}),
  });
  return runId;
}

/** The single runner row of a run, or undefined. */
async function runnerRow(runId: string) {
  const [row] = await db
    .select()
    .from(llmUsage)
    .where(eq(llmUsage.runId, runId))
    .orderBy(llmUsage.id);
  return row;
}

/**
 * Terminal closure exactly as the platform synthesises it (stall watchdog, boot
 * orphan sweep, container crash): a `RunResult` that carries no `cost`.
 *
 * Delegates to the REAL entry point rather than re-deriving one, so these tests
 * break if the synthesis path stops reconstructing the run's usage from
 * `runs.tokenUsage` or stops going through finalize's terminal barrier.
 */
async function synthesisedFinalize(runId: string): Promise<void> {
  await synthesiseFinalize(runId, {
    status: "failed",
    error: { message: "Server restarted while run was in progress." },
  });
}

/**
 * The refusal alarm's exact message. Pinned as a constant because operators
 * alert on the literal string — a reworded log is a broken alert, not a
 * cosmetic change.
 */
const REFUSAL_MESSAGE = "llm_usage: refused a runner snapshot on an already-settled run";

describe("llm_usage settlement — terminal barrier and post-settlement immutability", () => {
  let ctx: TestContext;
  // The refusal diagnostic is observable ONLY through the logger, and its value
  // is as much in what it does NOT say as in what it does — so it is spied on
  // for every test here, and installed LAST so the fixture's own writes never
  // count towards an assertion.
  let errorSpy: ReturnType<typeof spyOn<typeof logger, "error">>;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "settleorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
    errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restored per test so sibling files sharing this process keep a real logger.
    errorSpy.mockRestore();
  });

  it("a runner snapshot arriving after the run settled is refused, leaving the billed total intact", async () => {
    // The loss scenario, end to end: a metric event's ledger write fails and is
    // replayed asynchronously; the run closes meanwhile; the replay lands.
    const runId = await seedSinkRun(ctx, { tokenUsage: { input_tokens: 100, output_tokens: 50 } });

    // Snapshot #1 landed during the run: $5.
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 5,
      },
      { onConflict: "runner-monotonic" },
    );

    await synthesisedFinalize(runId);

    const [closed] = await db
      .select({ status: runs.status, sinkClosedAt: runs.sinkClosedAt, cost: runs.cost })
      .from(runs)
      .where(eq(runs.id, runId));
    expect(closed!.status).toBe("failed");
    expect(closed!.sinkClosedAt).not.toBeNull();
    // The barrier's own write is monotone: it never regresses the $5 snapshot
    // to the zero-cost synthesised terminal.
    expect(closed!.cost).toBe(5);

    // The row is now settled — a cursor consumer may claim it by id.
    const settledRows = await listLlmUsage({});
    expect(settledRows).toHaveLength(1);
    expect(settledRows[0]!.settled).toBe(true);
    expect(settledRows[0]!.costUsd).toBe(5);

    // The late replay of a HIGHER cumulative total: refused (returns null, no
    // event), row untouched. Applying it would have raised a total whose serial
    // id the consumer already claimed and will never re-read.
    const late = await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 400,
        outputTokens: 200,
        costUsd: 9,
      },
      { onConflict: "runner-monotonic" },
    );
    expect(late).toBeNull();

    const row = await runnerRow(runId);
    expect(row!.costUsd).toBe(5);
    expect(row!.inputTokens).toBe(100);
    expect(await computeRunCost(runId, ctx.orgId)).toBe(5);

    // …and it is LOUD. This is money the platform consumed and will never
    // invoice, so the only way an operator learns about it is this line. It
    // fires exactly once (nothing before it in this test refused anything real)
    // and carries the whole picture: both cumulative totals plus the delta —
    // $4 — which is the figure a human acts on. Asserting the arithmetic, not
    // just the presence of a field, is what stops a future refactor from
    // reporting the incoming total as the loss.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = errorSpy.mock.calls[0]!;
    expect(message).toBe(REFUSAL_MESSAGE);
    expect(fields).toEqual({
      runId,
      orgId: ctx.orgId,
      runStatus: "failed",
      storedCostUsd: 5,
      incomingCostUsd: 9,
      refusedDeltaUsd: 4,
    });
  });

  it("the platform's defensive second finalize of a settled run is refused SILENTLY (issue #997)", async () => {
    // The whole production shape, end to end, on the real code path. A container
    // exits 0 after POSTing its own finalize; `execute-background.ts` synthesises
    // a success finalize anyway (it cannot know the container already did), and
    // `synthesiseFinalize` carries no cost — so finalize's terminal barrier
    // re-submits the run's OWN last snapshot at `costUsd: 0` onto a row that is
    // already settled. The upsert refuses it, correctly: nothing is lost, the
    // stored total already dominates. Reporting that as a billing loss produced
    // ~25 bogus error lines per container lifetime in production (issue #997),
    // every one of them with a refused amount of 0.
    const runId = await seedSinkRun(ctx, { tokenUsage: { input_tokens: 100, output_tokens: 50 } });

    // 1. The container's own finalize: cost + usage, barrier writes, CAS settles.
    const run = await getRunSinkContext(runId);
    const result = emptyRunResult();
    result.status = "success";
    result.cost = 5;
    result.usage = { input_tokens: 100, output_tokens: 50 };
    await finalizeRun({ run: run!, result });

    const settled = await listLlmUsage({});
    expect(settled).toHaveLength(1);
    expect(settled[0]!.settled).toBe(true);
    expect(settled[0]!.costUsd).toBe(5);

    // 2. The defensive synthesis that follows every clean container exit.
    await synthesiseFinalize(runId, { status: "success" });

    // The row is untouched (post-settlement immutability holds) …
    const row = await runnerRow(runId);
    expect(row!.costUsd).toBe(5);
    expect(row!.inputTokens).toBe(100);
    expect(row!.outputTokens).toBe(50);
    // … and the run keeps the terminal status its first finalize won.
    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
    expect(runRow!.status).toBe("success");

    // The assertion this test exists for: not one error line for the entire
    // lifecycle. A benign trailing replay is not an incident.
    expect(errorSpy).toHaveBeenCalledTimes(0);
  });

  it("an exact duplicate replay on a settled run is refused silently", async () => {
    // Idempotence, seen from the diagnostic's side: the durable-retry replay of
    // a snapshot that already landed loses nothing, so it must not page anyone.
    // Both levels of the advance rule use STRICT inequalities precisely so this
    // case is a no-op rather than a re-emitted row.
    const runId = await seedSinkRun(ctx, { tokenUsage: null });
    const entry = {
      source: "runner" as const,
      orgId: ctx.orgId,
      runId,
      credentialSource: "system" as const,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 3,
    };
    await recordLlmUsage(entry, { onConflict: "runner-monotonic" });
    await synthesisedFinalize(runId);

    expect(await recordLlmUsage(entry, { onConflict: "runner-monotonic" })).toBeNull();

    expect((await runnerRow(runId))!.costUsd).toBe(3);
    expect(errorSpy).toHaveBeenCalledTimes(0);
  });

  it("a late EQUAL-cost snapshot with more cached tokens is still reported — the zero-cost-model loss", async () => {
    // A model with no catalog rate (or a cache-only turn) holds `cost_usd` at a
    // constant while the token columns keep climbing. The refused delta is $0,
    // yet the loss is real: those tokens will never reach the ledger. A
    // cost-only advance test would have called this benign and stayed quiet, so
    // the diagnostic reuses the upsert's OWN two-level predicate — and this test
    // is what proves the COALESCE'd cache arms are actually wired into it, by
    // moving nothing but `cacheWriteTokens`.
    const runId = await seedSinkRun(ctx, { tokenUsage: null });
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 10,
        costUsd: 2,
      },
      { onConflict: "runner-monotonic" },
    );
    await synthesisedFinalize(runId);

    const late = await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 50,
        cacheWriteTokens: 30,
        costUsd: 2,
      },
      { onConflict: "runner-monotonic" },
    );
    expect(late).toBeNull();
    expect((await runnerRow(runId))!.cacheWriteTokens).toBe(10);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = errorSpy.mock.calls[0]!;
    expect(message).toBe(REFUSAL_MESSAGE);
    // NOTE the honest consequence of a token-only loss: `refusedDeltaUsd` is 0,
    // exactly like the benign #997 replay. The two are distinguishable by the
    // presence of the line, never by that field.
    expect(fields).toEqual({
      runId,
      orgId: ctx.orgId,
      runStatus: "failed",
      storedCostUsd: 2,
      incomingCostUsd: 2,
      refusedDeltaUsd: 0,
    });
  });

  it("a diagnostic that itself fails degrades to a warn and never fails the refused write", async () => {
    // The diagnostic added a SELECT to a path that previously did no I/O at all,
    // and it runs inside the terminal barrier, which calls the ledger with
    // `required: true` — a throw here would fail `finalizeRun` and leave a
    // finished run permanently unsettled. That is a strictly worse failure than
    // the missing log line it was meant to produce.
    //
    // Expressed through the service's own DI seam (`opts.executor`): an executor
    // whose INSERT is real but whose SELECT faults isolates the diagnostic query
    // as the single point of failure. No `mock.module()` (AGENTS.md).
    const runId = await seedSinkRun(ctx, { tokenUsage: null });
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 2,
      },
      { onConflict: "runner-monotonic" },
    );
    await synthesisedFinalize(runId);

    const diagnosticBlindExecutor = {
      insert: db.insert.bind(db),
      select() {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as Db;

    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      // A genuinely advancing snapshot, so the diagnostic is definitely reached.
      const late = await recordLlmUsage(
        {
          source: "runner",
          orgId: ctx.orgId,
          runId,
          credentialSource: "system",
          inputTokens: 400,
          outputTokens: 200,
          costUsd: 9,
        },
        { onConflict: "runner-monotonic", executor: diagnosticBlindExecutor },
      );
      // The write itself still reports its outcome normally.
      expect(late).toBeNull();
      expect((await runnerRow(runId))!.costUsd).toBe(2);
      // The failure is visible rather than swallowed …
      expect(warnSpy.mock.calls.map(([m]) => m)).toContain("llm_usage: refusal diagnostic failed");
      // … and, honestly stated: when the diagnostic cannot run, the real loss
      // goes UNREPORTED. Silence here is a known consequence of not letting the
      // explanation break the write, not evidence that nothing was lost.
      expect(errorSpy).toHaveBeenCalledTimes(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the same snapshot IS applied while the run is still open", async () => {
    // The mirror image of the test above — the guard must not freeze a live run.
    const runId = await seedSinkRun(ctx);
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 5,
      },
      { onConflict: "runner-monotonic" },
    );
    const advanced = await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 400,
        outputTokens: 200,
        costUsd: 9,
      },
      { onConflict: "runner-monotonic" },
    );
    expect(advanced).not.toBeNull();
    expect((await runnerRow(runId))!.costUsd).toBe(9);
  });

  it("a synthesised terminal with no result.cost still pins the run's usage before settling", async () => {
    // Watchdog / orphan-sweep shape: the RunResult is empty, and the only
    // record of what the run consumed is the `runs.tokenUsage` snapshot the
    // metric side channel wrote. Gating the barrier on `result.cost > 0` meant
    // these runs settled with no barrier at all — and, when no ledger row had
    // landed yet, with no ledger row either.
    const runId = await seedSinkRun(ctx, {
      tokenUsage: { input_tokens: 700, output_tokens: 120, cache_read_input_tokens: 40 },
    });

    await synthesisedFinalize(runId);

    const row = await runnerRow(runId);
    expect(row).toBeDefined();
    expect(row!.source).toBe("runner");
    expect(row!.inputTokens).toBe(700);
    expect(row!.outputTokens).toBe(120);
    expect(row!.cacheReadTokens).toBe(40);
    // The run row is terminal, so the ledger row is immediately billable.
    const rows = await listLlmUsage({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settled).toBe(true);
  });

  it("a run that consumed nothing mints no ledger row", async () => {
    const runId = await seedSinkRun(ctx, { tokenUsage: null });
    await synthesisedFinalize(runId);
    expect(await runnerRow(runId)).toBeUndefined();
    expect(await listLlmUsage({})).toEqual([]);
  });

  it("a run cannot settle with a stale total: a failed barrier write leaves it non-terminal", async () => {
    // The barrier is what makes settlement safe — but only if a FAILED barrier
    // write actually stops the CAS. If `required: true` ever stopped
    // propagating (or the barrier moved after the CAS), the run would flip
    // terminal while the ledger still holds the PREVIOUS cumulative total: the
    // billing cursor would claim that stale row by its serial id, once, and
    // never revisit it — the final delta silently lost.
    //
    // A CHECK constraint that rejects the terminal snapshot's cost simulates
    // the transient Postgres fault. Dropped in `finally` (with IF EXISTS) so a
    // failing assertion cannot leak it into the rest of the process.
    const runId = await seedSinkRun(ctx);
    // The run already has a durable cumulative total of $3.
    await recordLlmUsage(
      {
        source: "runner",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 3,
      },
      { onConflict: "runner-monotonic" },
    );

    await db.execute(
      sql`ALTER TABLE llm_usage ADD CONSTRAINT _test_reject_barrier CHECK (cost_usd != 7)`,
    );
    try {
      const run = await getRunSinkContext(runId);
      const result = emptyRunResult();
      result.status = "success";
      // The terminal snapshot the barrier must make durable: $7, superseding $3.
      result.cost = 7;

      // Pin the failure to the simulated barrier fault. Without naming the
      // constraint, a ReferenceError or a typo inside `finalizeRun` would throw
      // too — and would leave exactly the same "run still running, row still
      // unsettled" state, so every assertion below would pass for the wrong
      // reason. Drizzle wraps the driver error, so the constraint name is on
      // the cause, not the top-level message.
      let barrierError: unknown;
      try {
        await finalizeRun({ run: run!, result });
      } catch (err) {
        barrierError = err;
      }
      expect(barrierError).toBeDefined();
      const cause = (barrierError as { cause?: { message?: string; constraint?: string } }).cause;
      expect(
        `${(barrierError as Error).message} ${cause?.message ?? ""} ${cause?.constraint ?? ""}`,
      ).toContain("_test_reject_barrier");

      // The CAS never ran: the run is still open, so its ledger row is NOT
      // settled and no cursor consumer can claim it.
      const [runRow] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
      expect(runRow!.status).toBe("running");
      expect(runRow!.completedAt).toBeNull();

      const rows = await listLlmUsage({});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.settled).toBe(false);
      // And the total is still the last DURABLE one — never the stale-but-settled
      // combination the barrier exists to prevent.
      expect(rows[0]!.costUsd).toBe(3);
      // The cursor frontier stays BELOW this row's serial id, so a billing
      // consumer cannot advance past (and thereby permanently skip) it.
      expect(await getSettledFrontierId()).toBeLessThan(rows[0]!.id);
    } finally {
      await db.execute(sql`ALTER TABLE llm_usage DROP CONSTRAINT IF EXISTS _test_reject_barrier`);
    }
  });
});

describe("llm_usage durable retry — runner rows are never deferred", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "retryorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
  });

  /** Executor whose INSERT always fails — a transient Postgres fault. */
  const failingExecutor = {
    insert() {
      throw new Error("connection terminated unexpectedly");
    },
  } as unknown as Db;

  it("propagates a failed runner write instead of queueing it", async () => {
    const runId = await seedSinkRun(ctx);
    // Queueing it would mean replaying a stale cumulative total minutes later,
    // by which time the run has settled and the replay is refused — the delta
    // would be lost with no caller ever informed. Propagating rolls back the
    // ingestion transaction, so the runner re-POSTs and its NEXT cumulative
    // snapshot supersedes the lost one.
    await expect(
      recordLlmUsageReliably(
        {
          source: "runner",
          orgId: ctx.orgId,
          runId,
          credentialSource: "system",
          inputTokens: 10,
          outputTokens: 5,
          costUsd: 0.5,
        },
        { executor: failingExecutor, onConflict: "runner-monotonic" },
      ),
    ).rejects.toThrow("connection terminated unexpectedly");

    expect(await runnerRow(runId)).toBeUndefined();
  });

  it("absorbs a failed PROXY write into the durable queue and the worker PERSISTS it", async () => {
    // Proxy rows keep the queue: each is an immutable per-call fact that gets a
    // FRESH serial id when it lands, so a late replay is still swept and billed.
    //
    // The contract is not "the call did not throw" — it is that the row
    // eventually reaches Postgres. Assert the end state: after the retry worker
    // drains, the row exists with the exact figures that failed to write
    // directly. Without this, a queue that silently dropped every job would
    // still pass.
    const requestId = `req_${crypto.randomUUID()}`;

    await recordLlmUsageReliably(
      {
        source: "proxy",
        orgId: ctx.orgId,
        model: "preset-x",
        credentialSource: "system",
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.5,
        requestId,
      },
      { executor: failingExecutor, onConflict: "proxy-idempotent" },
    );

    // The direct write failed, so nothing is in Postgres yet — the row exists
    // only as a queued job.
    expect(await db.select().from(llmUsage).where(eq(llmUsage.requestId, requestId))).toHaveLength(
      0,
    );

    // Start the consumer: it replays the job against the REAL db (the failing
    // executor never travels with the job).
    await initLlmUsageRetryWorker();
    try {
      const landed = await waitFor(async () => {
        const [row] = await db
          .select()
          .from(llmUsage)
          .where(eq(llmUsage.requestId, requestId))
          .limit(1);
        return row;
      });

      expect(landed).toBeDefined();
      expect(landed!.source).toBe("proxy");
      expect(landed!.orgId).toBe(ctx.orgId);
      expect(landed!.inputTokens).toBe(10);
      expect(landed!.outputTokens).toBe(5);
      expect(landed!.costUsd).toBe(0.5);
      // A fresh serial id above any cursor watermark — that is what makes a
      // late replay billable rather than stranded behind the frontier.
      expect(landed!.id).toBeGreaterThan(0);
    } finally {
      await _resetLlmUsageRetryWorkerForTests();
    }
  });
});

describe("llm_usage cursor read — the runner mirror of a proxy-metered run is not returned", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "mirrororg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, type: "agent" });
  });

  it("excludes the mirror from list + frontier, matching computeRunCost exactly", async () => {
    // A remote run metered per call by the llm-proxy: N proxy rows PLUS the
    // runner's cumulative mirror (credential_source NULL, because a remote run
    // resolves no platform model). Both describe the same spend.
    const runId = await seedSinkRun(ctx, { runOrigin: "remote", modelSource: null });
    await db.insert(llmUsage).values([
      {
        source: "proxy",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        costUsd: 0.4,
        requestId: "req_mirror_1",
      },
      {
        source: "proxy",
        orgId: ctx.orgId,
        runId,
        credentialSource: "system",
        costUsd: 0.6,
        requestId: "req_mirror_2",
      },
      { source: "runner", orgId: ctx.orgId, runId, credentialSource: null, costUsd: 1.0 },
    ]);

    const rows = await listLlmUsage({});
    expect(rows.map((r) => r.source)).toEqual(["proxy", "proxy"]);
    const swept = rows.reduce((sum, r) => sum + r.costUsd, 0);
    // A consumer that applies no filter of its own now sums exactly what the
    // canonical run-cost read reports — no double count.
    expect(swept).toBeCloseTo(await computeRunCost(runId, ctx.orgId), 10);
    expect(swept).toBeCloseTo(1.0, 10);

    // The frontier is computed over the same visible set: the in-flight run's
    // invisible (and unsettled) mirror must not pin it.
    const [lastVisible] = rows.slice(-1);
    expect(await getSettledFrontierId()).toBe(lastVisible!.id);
  });

  it("keeps the runner row of a run that has no proxy rows", async () => {
    const runId = await seedSinkRun(ctx, { runOrigin: "remote", modelSource: null });
    await db
      .insert(llmUsage)
      .values({ source: "runner", orgId: ctx.orgId, runId, credentialSource: null, costUsd: 2.5 });

    const rows = await listLlmUsage({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("runner");
    expect(await computeRunCost(runId, ctx.orgId)).toBe(2.5);
  });
});
