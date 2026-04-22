// SPDX-License-Identifier: Apache-2.0

/**
 * Parity E2E — proves the Appstrate adapters honour the runtime contract
 * end-to-end. Scenario:
 *
 *   1. A scripted generator yields a canonical RunEvent sequence.
 *   2. The sink forwards every event to the runtime reducer (incremental)
 *      and fans out to run_logs + platform accumulators.
 *   3. The run produces the same RunResult a runtime consumer would get
 *      from `reduceEvents` over the same stream.
 *   4. run_logs rows + the sink's projected aggregate reflect the expected
 *      DB side-effects (output + report + progress rows; memories
 *      captured in-memory for persistence by the caller).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { AppstrateEventSink } from "../../../src/services/adapters/appstrate-event-sink.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { reduceEvents } from "@appstrate/afps-runtime/runner";
import { db } from "@appstrate/db/client";
import { runLogs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

describe("Parity E2E — full adapter stack", () => {
  let ctx: TestContext;
  const agentId = "@testorg/parity";
  let runId: string;

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

  it("inline executor loop → AppstrateEventSink produces the same RunResult as reduceEvents", async () => {
    const script: RunEvent[] = [
      {
        type: "appstrate.progress",
        timestamp: Date.now(),
        runId,
        message: "booting",
        level: "info",
      },
      { type: "memory.added", timestamp: Date.now(), runId, content: "learned A" },
      { type: "memory.added", timestamp: Date.now(), runId, content: "learned B" },
      {
        type: "output.emitted",
        timestamp: Date.now(),
        runId,
        data: { deliverable: "shipped" },
      },
      { type: "state.set", timestamp: Date.now(), runId, state: { counter: 7 } },
      { type: "report.appended", timestamp: Date.now(), runId, content: "work done" },
    ];

    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });

    // Mirror the production inline loop (routes/runs.ts:executeAgentInBackground).
    async function* scripted() {
      for (const ev of script) yield ev;
    }
    for await (const ev of scripted()) {
      await sink.handle(ev);
    }
    const result = reduceEvents(script);
    await sink.finalize(result);

    // Reducer agreement: the sink's finalised result MUST match what any
    // external runtime consumer would get from reducing the same event stream.
    expect(sink.result).toEqual(result);

    // Sink aggregate projects the runtime snapshot into DB-friendly shapes.
    expect(sink.current.output).toEqual({ deliverable: "shipped" });
    expect(sink.current.state).toEqual({ counter: 7 });
    expect(sink.current.memories).toEqual(["learned A", "learned B"]);
    expect(sink.current.report).toBe("work done");

    // DB side-effect: run_logs received one row per observable event
    // (output + report + progress).
    const logs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, ctx.orgId)))
      .orderBy(asc(runLogs.id));

    const events = logs.map((l) => l.event);
    expect(events).toContain("output");
    expect(events).toContain("report");
    expect(events).toContain("progress");
  });
});
