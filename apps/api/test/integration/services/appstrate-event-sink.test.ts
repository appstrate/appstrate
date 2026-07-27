// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for {@link PersistingEventSink} — the stateless write-through
 * used by the ingestion hot path. Covers the run_logs fan-out for every
 * routed event type, the `runs.tokenUsage` snapshot, and the `llm_usage`
 * ledger row (including the fail-closed `writeLedger` default).
 *
 * Reducer / `snapshot()` semantics belong to `createReducerSink()` and
 * are covered by `packages/afps-runtime/test/sinks/reducer-sink.test.ts`;
 * the reducer-plus-sink composition a read-back consumer writes is
 * covered end-to-end by `parity-e2e.test.ts`.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { PersistingEventSink } from "../../../src/services/run-launcher/appstrate-event-sink.ts";
import { _resetRunMetricBroadcasterForTests } from "../../../src/services/run-metric-broadcaster.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { ModelCost } from "@appstrate/core/module";
import { emptyRunResult } from "@appstrate/afps-runtime/runner";
import { db } from "@appstrate/db/client";
import { runLogs, llmUsage, runs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

describe("PersistingEventSink", () => {
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

  /** Sink with the production defaults — notably `writeLedger` off. */
  function newSink() {
    return new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
  }

  async function loadLogs() {
    return db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, ctx.orgId)))
      .orderBy(asc(runLogs.id));
  }

  it("output.emitted → one result/output run_log row per emission", async () => {
    const sink = newSink();
    await sink.handle(event("output.emitted", { data: { a: 1, b: 2 } }));
    await sink.handle(event("output.emitted", { data: { b: 3, c: 4 } }));

    const outputLogs = (await loadLogs()).filter((l) => l.event === "output");
    expect(outputLogs).toHaveLength(2);
    expect(outputLogs[0]!.type).toBe("result");
    expect(outputLogs[0]!.data).toEqual({ a: 1, b: 2 });
    expect(outputLogs[1]!.data).toEqual({ b: 3, c: 4 });
  });

  // The `report` runtime tool was removed in favour of durable `outputs/`
  // documents. A stale runner still emitting its event must be dropped by the
  // sink's `default:` branch — no run_logs row, no throw.
  it("drops the retired report.appended event entirely", async () => {
    const sink = newSink();
    await sink.handle(event("report.appended", { content: "# First" }));

    expect(await loadLogs()).toHaveLength(0);
  });

  it("maps log.written into run_logs with the original level + message", async () => {
    const sink = newSink();
    await sink.handle(event("log.written", { level: "info", message: "booting" }));
    await sink.handle(event("log.written", { level: "warn", message: "retry" }));

    const progressLogs = (await loadLogs()).filter((l) => l.type === "progress");
    expect(progressLogs.map((l) => l.message)).toEqual(["booting", "retry"]);
    expect(progressLogs.map((l) => l.level)).toEqual(["info", "warn"]);
    // `log.written` is tagged `event='log'` (vs lifecycle/tool `'progress'`) so
    // the chat run card can show ONLY the agent's explicit log-tool output.
    expect(progressLogs.map((l) => l.event)).toEqual(["log", "log"]);
  });

  it("maps appstrate.progress into progress run_logs with message/data/level", async () => {
    const sink = newSink();
    await sink.handle(
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
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });
    await sink.handle(
      event("appstrate.metric", {
        usage: { input_tokens: 300, output_tokens: 125 },
        cost: 0.003,
      }),
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

    // runs.cost is intentionally NOT asserted here — the sink schedules a
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
      totals.map((cost) => {
        const sink = new PersistingEventSink({
          scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
          runId,
          writeLedger: true,
        });
        return sink.handle(
          event("appstrate.metric", {
            usage: { input_tokens: 100, output_tokens: 50 },
            cost,
          }),
        );
      }),
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
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });

    // First emit — cost 0.01, tokens 200/100
    await sink.handle(
      event("appstrate.metric", {
        usage: { input_tokens: 200, output_tokens: 100 },
        cost: 0.01,
      }),
    );

    // Second emit — REGRESSES to cost 0.005 (a finalize fallback that
    // raced an earlier metric event with a higher running total). The
    // monotonic guard MUST keep the higher value.
    await sink.handle(
      event("appstrate.metric", {
        usage: { input_tokens: 50, output_tokens: 25 },
        cost: 0.005,
      }),
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
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });

    // Three increasing emits — each must replace the previous row.
    await sink.handle(
      event("appstrate.metric", { usage: { input_tokens: 100, output_tokens: 0 }, cost: 0.001 }),
    );
    await sink.handle(
      event("appstrate.metric", { usage: { input_tokens: 200, output_tokens: 50 }, cost: 0.005 }),
    );
    await sink.handle(
      event("appstrate.metric", { usage: { input_tokens: 350, output_tokens: 120 }, cost: 0.012 }),
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
  // must not touch the billing ledger. Constructed inline (not via newSink())
  // so the omitted flag is visible at the assertion site.
  it("writeLedger off (default) → metric event still writes tokenUsage but no ledger row", async () => {
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(
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
    function ledgerSink(opts: { modelSource: string | null; modelCost: ModelCost | null }) {
      return new PersistingEventSink({
        scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
        runId,
        writeLedger: true,
        modelSource: opts.modelSource,
        modelCost: opts.modelCost,
      });
    }

    async function runnerRow() {
      const [row] = await db
        .select()
        .from(llmUsage)
        .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
      return row;
    }

    it("platform run whose model resolved NO pricing → `unpriced`, not a silent $0", async () => {
      const sink = ledgerSink({ modelSource: "system", modelCost: null });
      await sink.handle(
        event("appstrate.metric", { usage: { input_tokens: 900, output_tokens: 300 }, cost: 0 }),
      );

      const row = await runnerRow();
      expect(row!.costUsd).toBe(0);
      expect(row!.pricingStatus).toBe("unpriced");
    });

    it("platform run with rates → `priced`", async () => {
      const sink = ledgerSink({ modelSource: "org", modelCost: { input: 3, output: 15 } });
      await sink.handle(
        event("appstrate.metric", {
          usage: { input_tokens: 900, output_tokens: 300 },
          cost: 0.007,
        }),
      );

      expect((await runnerRow())!.pricingStatus).toBe("priced");
    });

    it("platform run that read cache with no cache-read rate → `partial`", async () => {
      const sink = ledgerSink({ modelSource: "system", modelCost: { input: 3, output: 15 } });
      await sink.handle(
        event("appstrate.metric", {
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000 },
          cost: 0.001,
        }),
      );

      expect((await runnerRow())!.pricingStatus).toBe("partial");
    });

    it("remote run (model_source NULL) → NULL status, never `unpriced`", async () => {
      // A NULL model source IS the remote-run signature (it resolved no
      // platform model — the same fact `notRunnerMirrorSql` keys on). Its
      // inference was accounted elsewhere; stamping a platform pricing gap on
      // it would mislabel every remote run.
      const sink = ledgerSink({ modelSource: null, modelCost: null });
      await sink.handle(
        event("appstrate.metric", { usage: { input_tokens: 900, output_tokens: 300 }, cost: 0.02 }),
      );

      const row = await runnerRow();
      expect(row!.credentialSource).toBeNull();
      expect(row!.pricingStatus).toBeNull();
    });

    it("a run with tokens but NO reported cost still gets a marked row", async () => {
      // `writeRunnerLedgerRow` only skips events with neither usage nor cost —
      // this row lands at cost 0, and it is exactly the one the status exists
      // to qualify.
      const sink = ledgerSink({ modelSource: "system", modelCost: null });
      await sink.handle(
        event("appstrate.metric", { usage: { input_tokens: 42, output_tokens: 7 } }),
      );

      const row = await runnerRow();
      expect(row).toBeDefined();
      expect(row!.costUsd).toBe(0);
      expect(row!.inputTokens).toBe(42);
      expect(row!.pricingStatus).toBe("unpriced");
    });
  });

  it("finalize is a no-op on the persisting sink", async () => {
    const sink = newSink();
    await expect(sink.finalize(emptyRunResult())).resolves.toBeUndefined();
  });

  it("appstrate.error → system/adapter_error run_log + lastError, most recent wins", async () => {
    const sink = newSink();
    expect(sink.lastError).toBeNull();

    await sink.handle(event("appstrate.error", { message: "OOM killed" }));
    await sink.handle(event("appstrate.error", { message: "boom" }));

    expect(sink.lastError).toBe("boom");

    const systemLogs = (await loadLogs()).filter((l) => l.type === "system");
    expect(systemLogs).toHaveLength(2);
    expect(systemLogs[0]!.event).toBe("adapter_error");
    expect(systemLogs[0]!.message).toBe("OOM killed");
    expect(systemLogs[0]!.level).toBe("error");
  });
});
