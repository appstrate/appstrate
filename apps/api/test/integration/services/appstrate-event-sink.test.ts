// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the two split sinks:
 *
 *   - {@link AggregatingEventSink} — long-lived, exposes `snapshot()`,
 *     `result`, `usage`, `cost`, `lastError` for parity tests +
 *     in-process runners. Verifies fan-out to run_logs + the
 *     in-memory reducer.
 *
 *   - {@link PersistingEventSink} — stateless persistence used by the
 *     ingestion hot path. Verifies fan-out to run_logs + ledger writes
 *     when `writeLedger` is enabled.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  AggregatingEventSink,
  PersistingEventSink,
} from "../../../src/services/adapters/appstrate-event-sink.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { reduceEvents, emptyRunResult } from "@appstrate/afps-runtime/runner";
import { db } from "@appstrate/db/client";
import { runLogs, llmUsage, runs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

describe("AggregatingEventSink", () => {
  let ctx: TestContext;
  const agentId = "@testorg/sink-agent";
  let runId: string;

  function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
    return { type, timestamp: Date.now(), runId, ...extra };
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
    const run = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
  });

  async function loadLogs() {
    return db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, ctx.orgId)))
      .orderBy(asc(runLogs.id));
  }

  function newSink() {
    return new AggregatingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
  }

  it("aggregates memory.added events into the memories list", async () => {
    const sink = newSink();
    await sink.handle(event("memory.added", { content: "first" }));
    await sink.handle(event("memory.added", { content: "second" }));

    expect(sink.snapshot().memories).toEqual([{ content: "first" }, { content: "second" }]);
  });

  it("stores pinned.set with key='checkpoint' as-is when payload is an object", async () => {
    const sink = newSink();
    await sink.handle(event("pinned.set", { key: "checkpoint", content: { counter: 42 } }));

    expect(sink.snapshot().pinned!.checkpoint).toEqual({ content: { counter: 42 } });
  });

  it("stores pinned.set with key='checkpoint' raw values verbatim (no projection — runtime keeps the payload)", async () => {
    const sink = newSink();
    await sink.handle(event("pinned.set", { key: "checkpoint", content: "just a string" }));

    expect(sink.snapshot().pinned!.checkpoint).toEqual({ content: "just a string" });
  });

  it("replaces output on each emission + writes a run log per call", async () => {
    const sink = newSink();
    await sink.handle(event("output.emitted", { data: { a: 1, b: 2 } }));
    await sink.handle(event("output.emitted", { data: { b: 3, c: 4 } }));

    expect(sink.snapshot().output).toEqual({ b: 3, c: 4 });

    const logs = await loadLogs();
    const outputLogs = logs.filter((l) => l.event === "output");
    expect(outputLogs).toHaveLength(2);
    expect(outputLogs[0]!.type).toBe("result");
    expect(outputLogs[0]!.data).toEqual({ a: 1, b: 2 });
  });

  it("stores output.emitted raw payload — runtime keeps the last emit verbatim", async () => {
    const sink = newSink();
    await sink.handle(event("output.emitted", { data: { a: 1 } }));
    await sink.handle(event("output.emitted", { data: [1, 2, 3] }));

    expect(sink.snapshot().output).toEqual([1, 2, 3]);
  });

  it("maps log.written into run_logs with the original level + message", async () => {
    const sink = newSink();
    await sink.handle(event("log.written", { level: "info", message: "booting" }));
    await sink.handle(event("log.written", { level: "warn", message: "retry" }));

    const logs = await loadLogs();
    const progressLogs = logs.filter((l) => l.type === "progress");
    expect(progressLogs.map((l) => l.message)).toEqual(["booting", "retry"]);
    expect(progressLogs.map((l) => l.level)).toEqual(["info", "warn"]);
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

    const logs = await loadLogs();
    const progressLogs = logs.filter((l) => l.type === "progress");
    expect(progressLogs).toHaveLength(1);
    expect(progressLogs[0]!.message).toBe("Tool: read_file");
    expect(progressLogs[0]!.data).toEqual({ tool: "read_file", args: { path: "/x" } });
    expect(progressLogs[0]!.level).toBe("info");
  });

  it("captures appstrate.error into lastAdapterError + writes system row", async () => {
    const sink = newSink();
    await sink.handle(event("appstrate.error", { message: "OOM killed" }));

    expect(sink.lastError).toBe("OOM killed");

    const logs = await loadLogs();
    const systemLogs = logs.filter((l) => l.type === "system");
    expect(systemLogs).toHaveLength(1);
    expect(systemLogs[0]!.event).toBe("adapter_error");
    expect(systemLogs[0]!.message).toBe("OOM killed");
    expect(systemLogs[0]!.level).toBe("error");
  });

  it("accumulates appstrate.metric usage + cost in memory", async () => {
    const sink = newSink();
    await sink.handle(
      event("appstrate.metric", {
        usage: { input_tokens: 100, output_tokens: 50 },
        cost: 0.001,
      }),
    );
    await sink.handle(
      event("appstrate.metric", {
        usage: { input_tokens: 200, output_tokens: 75 },
        cost: 0.002,
      }),
    );

    expect(sink.usage.input_tokens).toBe(300);
    expect(sink.usage.output_tokens).toBe(125);
    expect(sink.cost).toBeCloseTo(0.003, 5);

    // Aggregating sinks NEVER write the ledger — `writeLedger` is forced
    // off in the constructor, so the runner row is skipped.
    const ledgerRows = await db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.runId, runId), eq(llmUsage.source, "runner")));
    expect(ledgerRows).toHaveLength(0);
  });

  it("exposes the RunResult from the runtime reducer on finalize", async () => {
    const sink = newSink();
    const events: RunEvent[] = [
      event("memory.added", { content: "m" }),
      event("output.emitted", { data: { x: 1 } }),
    ];
    for (const ev of events) {
      await sink.handle(ev);
    }

    expect(sink.result).toBeNull();
    const result = reduceEvents(events);
    await sink.finalize(result);

    expect(sink.result).not.toBeNull();
    expect(sink.result?.memories).toEqual([{ content: "m" }]);
    expect(sink.result?.output).toEqual({ x: 1 });
  });

  it("is compatible with emptyRunResult as a baseline", async () => {
    const sink = newSink();
    await sink.finalize(emptyRunResult());
    expect(sink.result).toEqual(emptyRunResult());
  });

  it("snapshot/usage/cost/lastError never throw — totality across every public method (LSP)", async () => {
    const sink = newSink();
    // No events handled yet — every read MUST return a valid empty value.
    expect(() => sink.snapshot()).not.toThrow();
    expect(sink.snapshot().memories).toEqual([]);
    expect(sink.snapshot().pinned).toBeUndefined();
    expect(sink.snapshot().output).toBeNull();
    expect(sink.usage.input_tokens).toBe(0);
    expect(sink.cost).toBe(0);
    expect(sink.lastError).toBeNull();
  });
});

describe("PersistingEventSink", () => {
  let ctx: TestContext;
  const agentId = "@testorg/persist-agent";
  let runId: string;

  function event(type: string, extra: Record<string, unknown> = {}): RunEvent {
    return { type, timestamp: Date.now(), runId, ...extra };
  }

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext();
    await seedAgent({ id: agentId, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, agentId);
    const run = await seedRun({
      packageId: agentId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      dashboardUserId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
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

    // runs.cost MUST NOT be touched by the sink — only finalizeRun writes it.
    expect(runRow?.cost).toBeNull();
  });

  it("concurrent metric writes for the same run land at most one runner row", async () => {
    // The runner row is dedup'd via the partial unique index
    // `uq_llm_usage_runner_run_id`. Multiple concurrent writers (the
    // metric event handler and the finalize fallback) both target the
    // same key — whichever lands first owns the row, the others no-op
    // via ON CONFLICT DO NOTHING. The total row count is 1 regardless
    // of how many writers raced.
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
  });

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

  it("writes run_logs fan-out without exposing a current snapshot getter", async () => {
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });

    await sink.handle(event("output.emitted", { data: { x: 1 } }));

    // The persisting sink intentionally does NOT expose `snapshot()` —
    // accessing it is a TS error and at runtime the property is
    // undefined. Fan-out to run_logs is still verified.
    expect((sink as unknown as { snapshot?: unknown }).snapshot).toBeUndefined();

    const logs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.event, "output")))
      .orderBy(asc(runLogs.createdAt));
    expect(logs.length).toBeGreaterThan(0);
  });

  it("finalize is a no-op on the persisting sink", async () => {
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await expect(sink.finalize(emptyRunResult())).resolves.toBeUndefined();
  });

  it("lastError surfaces the most recent appstrate.error message", async () => {
    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("appstrate.error", { message: "boom" }));
    expect(sink.lastError).toBe("boom");
  });
});
