// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for {@link persistRunEvent} — the stateless write-through used by
 * the ingestion hot path. Covers the run_logs fan-out for every routed
 * event type, the `runs.tokenUsage` snapshot, and the `llm_usage` ledger
 * row (including the fail-closed `writeLedger` default).
 *
 * Reducer / `snapshot()` semantics belong to `createReducerSink()` and
 * are covered by `packages/afps-runtime/test/sinks/reducer-sink.test.ts`;
 * the reducer-plus-persist composition a read-back consumer writes is
 * covered end-to-end by `parity-e2e.test.ts`.
 */

import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  persistRunEvent,
  writeRunnerLedgerRow,
} from "../../../src/services/run-launcher/appstrate-event-sink.ts";
import { logger } from "../../../src/lib/logger.ts";
import { _resetRunMetricBroadcasterForTests } from "../../../src/services/run-metric-broadcaster.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { LEGACY_RUNTIME_TOOL_EVENT_TYPES } from "@appstrate/core/runtime-tool-defs";
import type { ModelCost } from "@appstrate/core/module";
import { db } from "@appstrate/db/client";
import { runLogs, llmUsage, runs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

describe("persistRunEvent", () => {
  let ctx: TestContext;
  const agentId = "@testorg/persist-agent";
  let runId: string;

  function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
    return { type, timestamp: Date.now(), runId, ...extra };
  }

  beforeEach(async () => {
    await truncateAll();
    // The broadcaster's throttle map is module-scoped — wipe it between
    // tests so a fire-and-forget broadcast scheduled by one test cannot
    // race a later test's reads of runs.cost. The broadcaster's own
    // behavior (including the runs.cost write) is covered by its
    // dedicated test suite (run-metric-broadcaster.test.ts).
    _resetRunMetricBroadcasterForTests();
    ctx = await createTestContext();
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
    const run = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
  });

  /** Persist with the production defaults — notably `writeLedger` off. */
  function persist(e: RunEvent, opts: Parameters<typeof persistRunEvent>[4] = {}) {
    return persistRunEvent(
      db,
      { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      e,
      opts,
    );
  }

  async function loadLogs() {
    return db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, ctx.orgId)))
      .orderBy(asc(runLogs.id));
  }

  it("output.emitted → one result/output run_log row per emission", async () => {
    await persist(event("output.emitted", { data: { a: 1, b: 2 } }));
    await persist(event("output.emitted", { data: { b: 3, c: 4 } }));

    const outputLogs = (await loadLogs()).filter((l) => l.event === "output");
    expect(outputLogs).toHaveLength(2);
    expect(outputLogs[0]!.type).toBe("result");
    expect(outputLogs[0]!.data).toEqual({ a: 1, b: 2 });
    expect(outputLogs[1]!.data).toEqual({ b: 3, c: 4 });
  });

  // The `report` runtime tool was removed in favour of durable `outputs/`
  // files. A stale runner still emitting its event must be dropped by
  // the dispatcher's `default:` branch — no run_logs row, no throw.
  it("drops the retired report.appended event entirely", async () => {
    await persist(event("report.appended", { content: "# First" }));

    expect(await loadLogs()).toHaveLength(0);
  });

  // The published-file event has more than one accepted spelling: the runtime
  // image and the platform deploy independently, so a container built before
  // #1177 still emits `document.published` / `document_id`. The set of accepted
  // spellings is core's `LEGACY_RUNTIME_TOOL_EVENT_TYPES`, so this test is
  // driven BY that table — a spelling core forwards but the sink does not
  // ingest is a file stored with no run_log to show for it, and nothing
  // anywhere saying why. Adding an entry to the table without touching the
  // sink must keep working; if it ever does not, this fails.
  it("ingests every published-file spelling core still forwards", async () => {
    const spellings = ["file.published", ...LEGACY_RUNTIME_TOOL_EVENT_TYPES];
    // Pins today's table so the loop cannot silently degrade to one case.
    expect(spellings).toContain("document.published");

    for (const type of spellings) {
      const id = `doc_${type.replace(/\W/g, "_")}`;
      // A pre-rename image emits the retired TYPE with the retired payload KEY.
      const payload = type.startsWith("document.") ? { document_id: id } : { file_id: id };
      await persist(event(type, { ...payload, name: "a.md", mime: "text/markdown", size: 3 }));
    }

    const fileLogs = (await loadLogs()).filter((l) => l.event === "file");
    expect(fileLogs).toHaveLength(spellings.length);
    expect(fileLogs.map((l) => l.type)).toEqual(spellings.map(() => "result"));
    expect(fileLogs.map((l) => (l.data as { file_id: string }).file_id)).toEqual(
      spellings.map((type) => `doc_${type.replace(/\W/g, "_")}`),
    );
  });

  it("maps log.written into run_logs with the original level + message", async () => {
    await persist(event("log.written", { level: "info", message: "booting" }));
    await persist(event("log.written", { level: "warn", message: "retry" }));

    const progressLogs = (await loadLogs()).filter((l) => l.type === "progress");
    expect(progressLogs.map((l) => l.message)).toEqual(["booting", "retry"]);
    expect(progressLogs.map((l) => l.level)).toEqual(["info", "warn"]);
    // `log.written` is tagged `event='log'` (vs lifecycle/tool `'progress'`) so
    // the chat run card can show ONLY the agent's explicit log-tool output.
    expect(progressLogs.map((l) => l.event)).toEqual(["log", "log"]);
  });

  it("maps appstrate.progress into progress run_logs with message/data/level", async () => {
    await persist(
      event("appstrate.progress", {
        message: "Tool: read_file",
        data: { tool: "read_file", args: { path: "/x" } },
        level: "info",
      }),
    );

    const progressLogs = (await loadLogs()).filter((l) => l.type === "progress");
    expect(progressLogs).toHaveLength(1);
    expect(progressLogs[0]!.message).toBe("Tool: read_file");
    expect(progressLogs[0]!.data).toEqual({ tool: "read_file", args: { path: "/x" } });
    expect(progressLogs[0]!.level).toBe("info");
  });

  // ---------------------------------------------------------------------
  // Monotonic upsert of the runner row. Every case runs on the PLATFORM shape
  // (`modelSource` + a rate snapshot), because that is the branch production
  // takes and the one where `cost_usd` is the platform's own product of
  // `runs.model_cost` × the reported tokens rather than the container's figure.
  // Run them without `modelSource` and they silently exercise the remote-origin
  // pass-through instead, leaving the mechanism that protects real billing
  // untested on the path it actually protects.
  //
  // Consequence worth stating: a cumulative snapshot can no longer advance by
  // "reporting a bigger cost". It advances by reporting bigger TOKEN counts —
  // so these tests drive the container's `cost` field in the wrong direction on
  // purpose, and the row still moves the right way.
  // ---------------------------------------------------------------------

  /** Rates shared by the upsert cases below. */
  const UPSERT_RATES: ModelCost = { input: 3, output: 15 };

  /** Persist a metric event on the platform path, at the shared rates. */
  function persistPlatformMetric(usage: Record<string, number>, cost: number) {
    return persist(event("appstrate.metric", { usage, cost }), {
      writeLedger: true,
      modelSource: "system",
      modelCost: UPSERT_RATES,
    });
  }

  async function loadRunnerRows() {
    return db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
  }

  it("appstrate.metric → single runner ledger row + tokenUsage snapshot when writeLedger is on", async () => {
    // 300×3/1e6 + 125×15/1e6 = 0.0009 + 0.001875. The container's 0.003 differs
    // from that on purpose — it must not be what lands.
    await persistPlatformMetric({ input_tokens: 300, output_tokens: 125 }, 0.003);

    const ledgerRows = await loadRunnerRows();
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.costUsd).toBeCloseTo(0.002775, 9);
    expect(ledgerRows[0]!.inputTokens).toBe(300);
    expect(ledgerRows[0]!.outputTokens).toBe(125);

    // runs.tokenUsage is a running-total snapshot (whole-object replace).
    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(runRow?.tokenUsage).toMatchObject({
      input_tokens: 300,
      output_tokens: 125,
    });

    // runs.cost is intentionally NOT asserted here — the metric branch schedules a
    // fire-and-forget run_metric broadcast that also refreshes runs.cost
    // (monotonic-max guarded) so a mid-run UI refresh sees the latest
    // value rather than null until finalize. That write race is covered
    // end-to-end by run-metric-broadcaster.test.ts; this test focuses on
    // the synchronous ledger + tokenUsage write-through.
  });

  it("concurrent metric writes for the same run land at most one runner row (max wins)", async () => {
    // The runner row is dedup'd via the partial unique index
    // `uq_llm_usage_runner_run_id`. The runner emits cumulative
    // running totals on every metric event, so concurrent writers
    // UPSERT with monotonic-max semantics — the highest-seen
    // total wins regardless of arrival order.
    //
    // The snapshots differ in TOKENS now, since that is what moves a
    // server-computed cost. The container's `cost` is pinned at 0 across all
    // five: if it were the recorded value, no writer could ever advance the row.
    const totals = [
      { input_tokens: 100, output_tokens: 50 },
      { input_tokens: 300, output_tokens: 150 },
      { input_tokens: 600, output_tokens: 300 },
      { input_tokens: 1_000, output_tokens: 500 },
      { input_tokens: 1_500, output_tokens: 750 },
    ];
    await Promise.all(totals.map((usage) => persistPlatformMetric(usage, 0)));

    const rows = await loadRunnerRows();
    expect(rows).toHaveLength(1);
    // Whichever order the writers landed in, the surviving row holds
    // the maximum total — never a regressed value.
    // 1500×3/1e6 + 750×15/1e6 = 0.0045 + 0.01125.
    expect(rows[0]!.costUsd).toBeCloseTo(0.01575, 9);
    expect(rows[0]!.inputTokens).toBe(1_500);
  });

  it("monotonic upsert: a smaller subsequent snapshot cannot regress the recorded value", async () => {
    // First emit — tokens 200/100 → 200×3/1e6 + 100×15/1e6 = 0.0006 + 0.0015.
    await persistPlatformMetric({ input_tokens: 200, output_tokens: 100 }, 0.01);

    // Second emit — REGRESSES to a quarter of the tokens (a finalize fallback
    // that raced an earlier metric event with a higher running total), while the
    // container simultaneously claims a HIGHER cost than the first event did.
    // Both halves matter: the guard must keep the larger recomputed value, and
    // the container's louder claim must not be able to raise the row.
    await persistPlatformMetric({ input_tokens: 50, output_tokens: 25 }, 99);

    const rows = await loadRunnerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeCloseTo(0.0021, 9);
    expect(rows[0]!.inputTokens).toBe(200);
    expect(rows[0]!.outputTokens).toBe(100);
  });

  it("monotonic upsert: a larger subsequent snapshot replaces the recorded value (streaming totals)", async () => {
    // Three increasing emits — each must replace the previous row. The
    // container's cost stays 0 throughout, so every advance here is the
    // platform's own arithmetic over the cumulative counters.
    await persistPlatformMetric({ input_tokens: 100, output_tokens: 0 }, 0);
    await persistPlatformMetric({ input_tokens: 200, output_tokens: 50 }, 0);
    await persistPlatformMetric({ input_tokens: 350, output_tokens: 120 }, 0);

    const rows = await loadRunnerRows();
    expect(rows).toHaveLength(1);
    // 350×3/1e6 + 120×15/1e6 = 0.00105 + 0.0018.
    expect(rows[0]!.costUsd).toBeCloseTo(0.00285, 9);
    expect(rows[0]!.inputTokens).toBe(350);
    expect(rows[0]!.outputTokens).toBe(120);
  });

  // Pins the FAIL-CLOSED default: a caller that never mentions `writeLedger`
  // must not touch the billing ledger — note the absent opts argument below.
  it("writeLedger off (default) → metric event still writes tokenUsage but no ledger row", async () => {
    await persist(
      event("appstrate.metric", {
        usage: { input_tokens: 10, output_tokens: 5 },
        cost: 0.0005,
      }),
    );

    const rows = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(rows).toHaveLength(0);

    // The token snapshot still lands on runs.tokenUsage even without ledger.
    const [runRow] = await db.select().from(runs).where(eq(runs.id, runId));
    expect(runRow?.tokenUsage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  });

  // Pricing provenance of the RUNNER row (issue #1025 §C). The container
  // computes the cost it reports, so the verdict is derived here from the
  // platform's own kickoff snapshot (`runs.model_cost` → `opts.modelCost`),
  // never from the container.
  describe("runner row pricing provenance", () => {
    function persistLedger(
      e: RunEvent,
      opts: { modelSource: string | null; modelCost: ModelCost | null },
    ) {
      return persist(e, { writeLedger: true, ...opts });
    }

    async function runnerRow() {
      const [row] = await db
        .select()
        .from(llmUsage)
        .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
      return row;
    }

    it("platform run whose model resolved NO pricing → `unpriced`, not a silent $0", async () => {
      await persistLedger(
        event("appstrate.metric", { usage: { input_tokens: 900, output_tokens: 300 }, cost: 0 }),
        { modelSource: "system", modelCost: null },
      );

      const row = await runnerRow();
      expect(row!.costUsd).toBe(0);
      expect(row!.pricingStatus).toBe("unpriced");
    });

    it("malformed `runs.model_cost` → `unpriced`, never a priced claim", async () => {
      // JSONB is only typed by convention. `classifyTokenPricing` probes
      // `cost == null` and `cost.cacheRead`, so an object that is neither —
      // `{}` from an older shape, or a hand-edited row — would sail through as
      // fully `priced`. The read path narrows with `modelCostSchema` so a
      // snapshot nobody can read is treated as no snapshot at all.
      await persistLedger(
        event("appstrate.metric", { usage: { input_tokens: 900, output_tokens: 300 }, cost: 0 }),
        { modelSource: "system", modelCost: {} as unknown as ModelCost },
      );

      const row = await runnerRow();
      expect(row!.pricingStatus).toBe("unpriced");
    });

    it("platform run with rates → `priced`", async () => {
      await persistLedger(
        event("appstrate.metric", {
          usage: { input_tokens: 900, output_tokens: 300 },
          cost: 0.007,
        }),
        { modelSource: "org", modelCost: { input: 3, output: 15 } },
      );

      expect((await runnerRow())!.pricingStatus).toBe("priced");
    });

    it("platform run that read cache with no cache-read rate → `partial`", async () => {
      await persistLedger(
        event("appstrate.metric", {
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000 },
          cost: 0.001,
        }),
        { modelSource: "system", modelCost: { input: 3, output: 15 } },
      );

      expect((await runnerRow())!.pricingStatus).toBe("partial");
    });

    it("remote run (model_source NULL) → NULL status, never `unpriced`", async () => {
      // A NULL model source IS the remote-run signature (it resolved no
      // platform model — the same fact `notRunnerMirrorSql` keys on). Its
      // inference was accounted elsewhere; stamping a platform pricing gap on
      // it would mislabel every remote run.
      await persistLedger(
        event("appstrate.metric", { usage: { input_tokens: 900, output_tokens: 300 }, cost: 0.02 }),
        { modelSource: null, modelCost: null },
      );

      const row = await runnerRow();
      expect(row!.credentialSource).toBeNull();
      expect(row!.pricingStatus).toBeNull();
    });

    it("a run with tokens but NO reported cost still gets a marked row", async () => {
      // `writeRunnerLedgerRow` only skips events with neither usage nor cost —
      // this row lands at cost 0, and it is exactly the one the status exists
      // to qualify.
      await persistLedger(
        event("appstrate.metric", { usage: { input_tokens: 42, output_tokens: 7 } }),
        { modelSource: "system", modelCost: null },
      );

      const row = await runnerRow();
      expect(row).toBeDefined();
      expect(row!.costUsd).toBe(0);
      expect(row!.inputTokens).toBe(42);
      expect(row!.pricingStatus).toBe("unpriced");
    });
  });

  /**
   * The ledger row's `cost_usd` is computed by the PLATFORM, from
   * `runs.model_cost` × the reported token counts — never taken from the `cost`
   * the agent container reports alongside them. The container is the sandbox the
   * platform is isolating, and `llm_usage.cost_usd` is the sole number the cloud
   * billing module debits credits from.
   *
   * Every test here makes the container's figure DIFFER from the correct product
   * on purpose, so an assertion passing by coincidence is impossible.
   */
  describe("runner row cost is server-computed", () => {
    /** Claude-Sonnet-class rates, chosen so the products are exact in binary. */
    const rates: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

    function persistLedger(
      e: RunEvent,
      opts: { modelSource: string | null; modelCost: ModelCost | null },
    ) {
      return persist(e, { writeLedger: true, ...opts });
    }

    async function runnerRow() {
      const [row] = await db
        .select()
        .from(llmUsage)
        .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
      return row;
    }

    it("prices the row from runs.model_cost × reported tokens, ignoring the container's number", async () => {
      await persistLedger(
        event("appstrate.metric", {
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 200_000,
            cache_read_input_tokens: 500_000,
            cache_creation_input_tokens: 100_000,
          },
          // A container claiming a wildly inflated total. Before this became
          // server-computed it would have been billed verbatim.
          cost: 999,
        }),
        { modelSource: "system", modelCost: rates },
      );

      // 1M×3 + 0.2M×15 + 0.5M×0.3 + 0.1M×3.75 = 3 + 3 + 0.15 + 0.375
      const row = await runnerRow();
      expect(row!.costUsd).toBeCloseTo(6.525, 9);
      expect(row!.costUsd).not.toBe(999);
      expect(row!.pricingStatus).toBe("priced");
    });

    it("a container UNDER-reporting is corrected upward just the same", async () => {
      // The recompute is not a cap on the container's claim — it replaces it in
      // both directions. A runner that reports 0 (the shape a container with no
      // `MODEL_COST` produces, which is where this change is headed) must still
      // be billed for what it consumed.
      await persistLedger(
        event("appstrate.metric", {
          usage: { input_tokens: 400_000, output_tokens: 100_000 },
          cost: 0,
        }),
        { modelSource: "org", modelCost: rates },
      );

      // 0.4M×3 + 0.1M×15 = 1.2 + 1.5
      expect((await runnerRow())!.costUsd).toBeCloseTo(2.7, 9);
    });

    it("tokens but NO rate snapshot → costUsd 0 classified `unpriced`, whatever the container claimed", async () => {
      // The absent-pricing zero, and the reason `pricing_status` exists: the
      // platform cannot price this run, so it records a 0 that says so rather
      // than laundering the container's unverifiable number into the ledger.
      await persistLedger(
        event("appstrate.metric", {
          usage: { input_tokens: 900, output_tokens: 300 },
          cost: 0.42,
        }),
        { modelSource: "system", modelCost: null },
      );

      const row = await runnerRow();
      expect(row!.costUsd).toBe(0);
      expect(row!.pricingStatus).toBe("unpriced");
      // The consumption itself is still on the row — an unpriced run is not an
      // unrecorded one.
      expect(row!.inputTokens).toBe(900);
      expect(row!.outputTokens).toBe(300);
    });

    it("a malformed rate snapshot prices at 0, never NaN", async () => {
      // `runs.model_cost` is JSONB. The same `modelCostSchema` narrowing that
      // keeps a malformed snapshot from claiming `priced` must also feed the
      // arithmetic — otherwise `computeTokenCost` multiplies by an absent
      // `input` rate and writes NaN into a billing column.
      await persistLedger(
        event("appstrate.metric", {
          usage: { input_tokens: 1_000, output_tokens: 500 },
          cost: 0.01,
        }),
        { modelSource: "system", modelCost: {} as unknown as ModelCost },
      );

      const row = await runnerRow();
      expect(Number.isNaN(row!.costUsd)).toBe(false);
      expect(row!.costUsd).toBe(0);
      expect(row!.pricingStatus).toBe("unpriced");
    });

    it("remote-origin run (model_source NULL) keeps the runner's reported cost", async () => {
      // A remote run resolved no platform model, so there are no rates to
      // recompute with — the same fact that leaves its `pricing_status` NULL.
      // Zeroing it instead would erase the only cost a remote run with no proxy
      // rows ever has.
      await persistLedger(
        event("appstrate.metric", {
          usage: { input_tokens: 900, output_tokens: 300 },
          cost: 0.02,
        }),
        { modelSource: null, modelCost: null },
      );

      const row = await runnerRow();
      expect(row!.costUsd).toBeCloseTo(0.02, 9);
      expect(row!.credentialSource).toBeNull();
      expect(row!.pricingStatus).toBeNull();
    });

    it("a cost-only metric on a platform run mints no row", async () => {
      // The degenerate-event guard now keys on the input the cost is DERIVED
      // from. With no usage snapshot the recompute is exactly 0, so the row
      // would be all-zero and pin no accounting fact.
      await persistLedger(event("appstrate.metric", { cost: 0.5 }), {
        modelSource: "system",
        modelCost: rates,
      });

      expect(await runnerRow()).toBeUndefined();
    });

    // The cutover instrument: while the container still reports a cost of its
    // own, a disagreement with the server's number is the only way a formula
    // divergence becomes visible on real traffic. Its FIRING POLICY is the
    // tested part — one line per run, at the terminal write, carrying the full
    // gap — because the alternative (one per metric event) buries the very
    // incident it reports: a broken formula diverges on every platform run at
    // once.
    describe("reported-cost divergence warn", () => {
      const DIVERGENCE_MESSAGE =
        "llm_usage: runner-reported cost diverges from the server-computed cost";

      /** Divergence lines only — `pricing-provenance` warns on this logger too. */
      function divergenceCalls(spy: ReturnType<typeof spyOn<typeof logger, "warn">>) {
        return spy.mock.calls.filter(([message]) => message === DIVERGENCE_MESSAGE);
      }

      it("stays silent on mid-run metric events, then reports the FULL gap once at the terminal write", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          // Three cumulative snapshots, each with a container cost that
          // diverges further from the platform's product. Server cost climbs
          // 0.3 → 0.6 → 0.9 (rates below); the container claims 1, 2, then 3.
          for (const [inputTokens, claimed] of [
            [100_000, 1],
            [200_000, 2],
            [300_000, 3],
          ] as const) {
            await persistLedger(
              event("appstrate.metric", {
                usage: { input_tokens: inputTokens, output_tokens: 0 },
                cost: claimed,
              }),
              { modelSource: "system", modelCost: { input: 3, output: 15 } },
            );
          }

          // Not one line yet: every mid-run gap is a strict prefix of the
          // terminal one, so reporting them adds nothing and multiplies noise.
          expect(divergenceCalls(warnSpy)).toHaveLength(0);

          // The terminal ledger barrier — the run's last write, and this
          // producer's natural once-per-run hook.
          await writeRunnerLedgerRow(
            { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
            runId,
            {
              cost: 3,
              usage: { input_tokens: 300_000, output_tokens: 0 },
              modelSource: "system",
              modelCost: { input: 3, output: 15 },
            },
            { required: true },
          );

          const calls = divergenceCalls(warnSpy);
          expect(calls).toHaveLength(1);
          // The magnitude an operator acts on is the WHOLE gap, not the first
          // small one: 3 claimed against 0.9 computed, i.e. the terminal 2.1 —
          // never the 0.7 the first snapshot diverged by.
          const fields = calls[0]![1] as Record<string, unknown>;
          expect(fields).toMatchObject({ runId, orgId: ctx.orgId, reportedCostUsd: 3 });
          expect(fields["costUsd"]).toBeCloseTo(0.9, 9);
          expect(fields["deltaUsd"]).toBeCloseTo(2.1, 9);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it("says nothing when the two numbers agree, or when there is no second number", async () => {
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        try {
          // Agreement: 100k×3/1e6 = 0.3, which is what the container reports.
          await writeRunnerLedgerRow(
            { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
            runId,
            {
              cost: 0.3,
              usage: { input_tokens: 100_000, output_tokens: 0 },
              modelSource: "system",
              modelCost: { input: 3, output: 15 },
            },
            { required: true },
          );
          expect(divergenceCalls(warnSpy)).toHaveLength(0);

          // Remote-origin: the reported number IS the recorded one, so there
          // are never two numbers to disagree.
          await writeRunnerLedgerRow(
            { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
            runId,
            {
              cost: 99,
              usage: { input_tokens: 500_000, output_tokens: 0 },
              modelSource: null,
              modelCost: null,
            },
            { required: true },
          );
          expect(divergenceCalls(warnSpy)).toHaveLength(0);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    it("a cost-only metric on a remote-origin run still mints its row", async () => {
      // The mirror image: the reported cost IS this row's derivation input, so
      // dropping the event would drop a spend fact.
      await persistLedger(event("appstrate.metric", { cost: 0.5 }), {
        modelSource: null,
        modelCost: null,
      });

      const row = await runnerRow();
      expect(row!.costUsd).toBeCloseTo(0.5, 9);
      expect(row!.inputTokens).toBe(0);
    });
  });

  it("appstrate.error → system/adapter_error run_log + the message is returned", async () => {
    // Only `appstrate.error` returns non-null: that return value is how the
    // ingestion path caches the last adapter error for the run.
    expect(await persist(event("output.emitted", { data: {} }))).toBeNull();

    expect(await persist(event("appstrate.error", { message: "OOM killed" }))).toBe("OOM killed");
    expect(await persist(event("appstrate.error", { message: "boom" }))).toBe("boom");

    const systemLogs = (await loadLogs()).filter((l) => l.type === "system");
    expect(systemLogs).toHaveLength(2);
    expect(systemLogs[0]!.event).toBe("adapter_error");
    expect(systemLogs[0]!.message).toBe("OOM killed");
    expect(systemLogs[0]!.level).toBe("error");
  });
});
