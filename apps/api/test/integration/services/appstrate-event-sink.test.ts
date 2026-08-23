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

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { persistRunEvent } from "../../../src/services/run-launcher/appstrate-event-sink.ts";
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

  it("appstrate.metric → single runner ledger row + tokenUsage snapshot when writeLedger is on", async () => {
    await persist(
      event("appstrate.metric", {
        usage: { input_tokens: 300, output_tokens: 125 },
        cost: 0.003,
      }),
      { writeLedger: true },
    );

    const ledgerRows = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.costUsd).toBeCloseTo(0.003, 5);
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
    // `cost_usd` wins regardless of arrival order.
    const totals = [0.001, 0.003, 0.006, 0.01, 0.015];
    await Promise.all(
      totals.map((cost) =>
        persist(
          event("appstrate.metric", {
            usage: { input_tokens: 100, output_tokens: 50 },
            cost,
          }),
          { writeLedger: true },
        ),
      ),
    );

    const rows = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(rows).toHaveLength(1);
    // Whichever order the writers landed in, the surviving row holds
    // the maximum cost — never a regressed value.
    expect(rows[0]!.costUsd).toBeCloseTo(0.015, 5);
  });

  it("monotonic upsert: a smaller subsequent cost cannot regress the recorded value", async () => {
    // First emit — cost 0.01, tokens 200/100
    await persist(
      event("appstrate.metric", {
        usage: { input_tokens: 200, output_tokens: 100 },
        cost: 0.01,
      }),
      { writeLedger: true },
    );

    // Second emit — REGRESSES to cost 0.005 (a finalize fallback that
    // raced an earlier metric event with a higher running total). The
    // monotonic guard MUST keep the higher value.
    await persist(
      event("appstrate.metric", {
        usage: { input_tokens: 50, output_tokens: 25 },
        cost: 0.005,
      }),
      { writeLedger: true },
    );

    const rows = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeCloseTo(0.01, 5);
    expect(rows[0]!.inputTokens).toBe(200);
    expect(rows[0]!.outputTokens).toBe(100);
  });

  it("monotonic upsert: a larger subsequent cost replaces the recorded value (streaming totals)", async () => {
    // Three increasing emits — each must replace the previous row.
    await persist(
      event("appstrate.metric", { usage: { input_tokens: 100, output_tokens: 0 }, cost: 0.001 }),
      {
        writeLedger: true,
      },
    );
    await persist(
      event("appstrate.metric", { usage: { input_tokens: 200, output_tokens: 50 }, cost: 0.005 }),
      {
        writeLedger: true,
      },
    );
    await persist(
      event("appstrate.metric", { usage: { input_tokens: 350, output_tokens: 120 }, cost: 0.012 }),
      {
        writeLedger: true,
      },
    );

    const rows = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeCloseTo(0.012, 5);
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
