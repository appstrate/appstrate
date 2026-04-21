// SPDX-License-Identifier: Apache-2.0

/**
 * Parity E2E — proves the Appstrate adapters honour the runtime contract
 * end-to-end. Scenario:
 *
 *   1. A scripted adapter yields a canonical RunEvent sequence.
 *   2. AppstrateContainerRunner forwards events to AppstrateEventSink.
 *   3. The run produces the same RunResult a runtime consumer would get
 *      from `reduceEvents` over the same stream.
 *   4. run_logs rows + the sink's aggregator reflect the expected
 *      DB side-effects (output + report + progress rows; memories
 *      captured in-memory for persistence by the caller).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { AppstrateEventSink } from "../../../src/services/adapters/appstrate-event-sink.ts";
import { AppstrateContainerRunner } from "../../../src/services/adapters/appstrate-container-runner.ts";
import type { AppstrateRunPlan, RunAdapter } from "../../../src/services/adapters/types.ts";
import type { RunEvent, ExecutionContext } from "@appstrate/afps-runtime/types";
import { reduceEvents } from "@appstrate/afps-runtime/runner";
import { db } from "@appstrate/db/client";
import { runLogs } from "@appstrate/db/schema";
import { eq, and, asc } from "drizzle-orm";

class ScriptedAdapter implements RunAdapter {
  constructor(private readonly script: RunEvent[]) {}
  async *execute(
    _runId: string,
    _context: ExecutionContext,
    _plan: AppstrateRunPlan,
    _signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    for (const ev of this.script) yield ev;
  }
}

function basePlan(): AppstrateRunPlan {
  return {
    rawPrompt: "Parity agent body: topic={{input.topic}}",
    schemaVersion: "1.2",
    schemas: {},
    llmConfig: {
      api: "anthropic-messages",
      modelId: "test",
      apiKey: "test",
      baseUrl: "",
      input: ["text"],
      contextWindow: 0,
      maxTokens: 0,
      reasoning: false,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      } as AppstrateRunPlan["llmConfig"]["cost"],
    },
    runApi: { url: "", token: "" },
    proxyUrl: null,
    timeout: 60,
    tokens: {},
    providers: [],
    availableTools: [],
    availableSkills: [],
    toolDocs: [],
  };
}

function baseContext(runId: string): ExecutionContext {
  return {
    runId,
    input: { topic: "parity" },
    memories: [],
    config: {},
  };
}

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

  it("AppstrateContainerRunner → AppstrateEventSink produces the same RunResult as reduceEvents", async () => {
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

    const runner = new AppstrateContainerRunner({
      adapter: new ScriptedAdapter(script),
      plan: basePlan(),
    });
    const sink = new AppstrateEventSink({ scope: { orgId: ctx.orgId }, runId });

    const result = await runner.run({ runId, context: baseContext(runId), sink });

    // Reducer agreement: the runner's result MUST match what any external
    // runtime consumer would get from reducing the same event stream.
    const expected = reduceEvents(script);
    expect(result).toEqual(expected);

    // Sink aggregate mirrors the result.
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
