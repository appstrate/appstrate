// SPDX-License-Identifier: Apache-2.0

/**
 * AppstrateEventSink — verifies fan-out to run_logs + the internal
 * aggregator for the AFPS 1.3 canonical events and the `appstrate.*`
 * platform-specific namespace.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { AppstrateEventSink } from "../../../src/services/adapters/appstrate-event-sink.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { reduceEvents, emptyRunResult } from "@appstrate/afps-runtime/runner";
import { db } from "@appstrate/db/client";
import { runLogs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

describe("AppstrateEventSink", () => {
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

  it("aggregates memory.added events into the memories list", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("memory.added", { content: "first" }));
    await sink.handle(event("memory.added", { content: "second" }));

    expect(sink.current.memories).toEqual(["first", "second"]);
  });

  it("stores state.set as-is when payload is an object", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("state.set", { state: { counter: 42 } }));

    expect(sink.current.state).toEqual({ counter: 42 });
  });

  it("projects non-object state.set payloads to null (runtime stores raw, projection drops)", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("state.set", { state: "just a string" }));

    expect(sink.current.state).toBeNull();
  });

  it("replaces output on each emission + writes a run log per call", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("output.emitted", { data: { a: 1, b: 2 } }));
    await sink.handle(event("output.emitted", { data: { b: 3, c: 4 } }));

    expect(sink.current.output).toEqual({ b: 3, c: 4 });

    const logs = await loadLogs();
    const outputLogs = logs.filter((l) => l.event === "output");
    expect(outputLogs).toHaveLength(2);
    expect(outputLogs[0]!.type).toBe("result");
    expect(outputLogs[0]!.data).toEqual({ a: 1, b: 2 });
  });

  it("projects non-object output replacement to empty object (runtime stores raw, projection drops)", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("output.emitted", { data: { a: 1 } }));
    await sink.handle(event("output.emitted", { data: [1, 2, 3] }));

    expect(sink.current.output).toEqual({});
  });

  it("concatenates report.appended events with \\n (runtime-canonical) + writes a run log per line", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("report.appended", { content: "line one" }));
    await sink.handle(event("report.appended", { content: "line two" }));

    expect(sink.current.report).toBe("line one\nline two");

    const logs = await loadLogs();
    const reportLogs = logs.filter((l) => l.event === "report");
    expect(reportLogs).toHaveLength(2);
    expect(reportLogs[0]!.data).toEqual({ content: "line one" });
  });

  it("maps log.written into run_logs with the original level + message", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("log.written", { level: "info", message: "booting" }));
    await sink.handle(event("log.written", { level: "warn", message: "retry" }));

    const logs = await loadLogs();
    const progressLogs = logs.filter((l) => l.type === "progress");
    expect(progressLogs.map((l) => l.message)).toEqual(["booting", "retry"]);
    expect(progressLogs.map((l) => l.level)).toEqual(["info", "warn"]);
  });

  it("maps appstrate.progress into progress run_logs with message/data/level", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
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
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.handle(event("appstrate.error", { message: "OOM killed" }));

    expect(sink.current.lastAdapterError).toBe("OOM killed");

    const logs = await loadLogs();
    const systemLogs = logs.filter((l) => l.type === "system");
    expect(systemLogs).toHaveLength(1);
    expect(systemLogs[0]!.event).toBe("adapter_error");
    expect(systemLogs[0]!.message).toBe("OOM killed");
    expect(systemLogs[0]!.level).toBe("error");
  });

  it("accumulates appstrate.metric usage + cost", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
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

    expect(sink.current.usage.input_tokens).toBe(300);
    expect(sink.current.usage.output_tokens).toBe(125);
    expect(sink.current.cost).toBeCloseTo(0.003, 5);
  });

  it("exposes the RunResult from the runtime reducer on finalize", async () => {
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
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
    const sink = new AppstrateEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });
    await sink.finalize(emptyRunResult());
    expect(sink.result).toEqual(emptyRunResult());
  });
});
