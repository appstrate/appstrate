// SPDX-License-Identifier: Apache-2.0

/**
 * AppstrateEventSink — verifies fan-out to run_logs + the internal
 * aggregator for each of the 5 canonical AFPS events.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { AppstrateEventSink } from "../../../src/services/adapters/appstrate-event-sink.ts";
import type { AfpsEvent, AfpsEventEnvelope } from "@appstrate/afps-runtime/types";
import { reduceEvents, emptyRunResult } from "@appstrate/afps-runtime/runner";
import { db } from "@appstrate/db/client";
import { runLogs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

describe("AppstrateEventSink", () => {
  let ctx: TestContext;
  const agentId = "@testorg/sink-agent";
  let runId: string;

  function envelope(seq: number, event: AfpsEvent): AfpsEventEnvelope {
    return { runId, sequence: seq, event };
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

  it("aggregates add_memory events into the memories list", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "add_memory", content: "first" }));
    await sink.onEvent(envelope(1, { type: "add_memory", content: "second" }));

    expect(sink.current.memories).toEqual(["first", "second"]);
  });

  it("stores set_state as-is when payload is an object", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "set_state", state: { counter: 42 } }));

    expect(sink.current.state).toEqual({ counter: 42 });
  });

  it("wraps non-object set_state payloads under `value`", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "set_state", state: "just a string" }));

    expect(sink.current.state).toEqual({ value: "just a string" });
  });

  it("merges object outputs JSON-merge-patch style + writes a run log", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "output", data: { a: 1, b: 2 } }));
    await sink.onEvent(envelope(1, { type: "output", data: { b: 3, c: 4 } }));

    expect(sink.current.output).toEqual({ a: 1, b: 3, c: 4 });

    const logs = await loadLogs();
    const outputLogs = logs.filter((l) => l.event === "output");
    expect(outputLogs).toHaveLength(2);
    expect(outputLogs[0]!.type).toBe("result");
    expect(outputLogs[0]!.data).toEqual({ a: 1, b: 2 });
  });

  it("replaces output wholesale for non-object payloads", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "output", data: { a: 1 } }));
    await sink.onEvent(envelope(1, { type: "output", data: [1, 2, 3] }));

    expect(sink.current.output).toEqual({ value: [1, 2, 3] });
  });

  it("concatenates report events with \\n\\n + writes a run log per line", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "report", content: "line one" }));
    await sink.onEvent(envelope(1, { type: "report", content: "line two" }));

    expect(sink.current.report).toBe("line one\n\nline two");

    const logs = await loadLogs();
    const reportLogs = logs.filter((l) => l.event === "report");
    expect(reportLogs).toHaveLength(2);
    expect(reportLogs[0]!.data).toEqual({ content: "line one" });
  });

  it("maps log events into run_logs with the original level + message", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.onEvent(envelope(0, { type: "log", level: "info", message: "booting" }));
    await sink.onEvent(envelope(1, { type: "log", level: "warn", message: "retry" }));

    const logs = await loadLogs();
    const progressLogs = logs.filter((l) => l.type === "progress");
    expect(progressLogs.map((l) => l.message)).toEqual(["booting", "retry"]);
    expect(progressLogs.map((l) => l.level)).toEqual(["info", "warn"]);
  });

  it("exposes the RunResult from the runtime reducer on finalize", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    const events: AfpsEvent[] = [
      { type: "add_memory", content: "m" },
      { type: "output", data: { x: 1 } },
    ];
    for (const [i, event] of events.entries()) {
      await sink.onEvent(envelope(i, event));
    }

    expect(sink.result).toBeNull();
    const result = reduceEvents(events);
    await sink.finalize(result);

    expect(sink.result).not.toBeNull();
    expect(sink.result?.memories).toEqual([{ content: "m" }]);
    expect(sink.result?.output).toEqual({ x: 1 });
  });

  it("is compatible with emptyRunResult as a baseline", async () => {
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });
    await sink.finalize(emptyRunResult());
    expect(sink.result).toEqual(emptyRunResult());
  });
});
