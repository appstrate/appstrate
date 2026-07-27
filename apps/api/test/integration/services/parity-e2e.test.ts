// SPDX-License-Identifier: Apache-2.0

/**
 * Parity E2E — proves the Appstrate adapters honour the runtime contract
 * end-to-end. Scenario:
 *
 *   1. A scripted generator yields a canonical RunEvent sequence.
 *   2. Each event is driven through the pair a read-back consumer
 *      composes: the runtime reducer (incremental aggregation) and the
 *      platform's {@link PersistingEventSink} (run_logs fan-out).
 *   3. The incremental reduction matches what any runtime consumer would
 *      get from `reduceEvents` over the same stream.
 *   4. run_logs rows reflect the expected DB side-effects (output +
 *      progress rows; memories stay in the reducer, never in run_logs).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { PersistingEventSink } from "../../../src/services/run-launcher/appstrate-event-sink.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import { createReducerSink } from "@appstrate/afps-runtime/sinks";
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
      userId: ctx.user.id,
      status: "running",
    });
    runId = run.id;
  });

  it("reducer + PersistingEventSink over a streamed script match reduceEvents and fan out to run_logs", async () => {
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
      {
        type: "pinned.set",
        timestamp: Date.now(),
        runId,
        key: "checkpoint",
        content: { counter: 7 },
      },
    ];

    // A consumer that needs a read-back aggregate composes the runtime
    // reducer with the platform's persisting sink and drives both — the
    // platform's own ingestion path only ever builds the persisting half.
    const reducer = createReducerSink();
    const persisting = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
    });

    async function* scripted() {
      for (const ev of script) yield ev;
    }
    for await (const ev of scripted()) {
      await reducer.sink.handle(ev);
      await persisting.handle(ev);
    }

    // Reducer agreement: folding the stream event-by-event MUST land on the
    // same RunResult an external consumer gets from a one-shot reduce.
    const snap = reducer.snapshot();
    expect(snap).toEqual(reduceEvents(script));

    // Snapshot is the runtime's own RunResult shape — no platform projection.
    expect(snap.output).toEqual({ deliverable: "shipped" });
    expect(snap.pinned!.checkpoint).toEqual({ content: { counter: 7 } });
    expect(snap.memories).toEqual([{ content: "learned A" }, { content: "learned B" }]);

    // DB side-effect: run_logs received one row per observable event
    // (output + progress).
    const logs = await db
      .select()
      .from(runLogs)
      .where(and(eq(runLogs.runId, runId), eq(runLogs.orgId, ctx.orgId)))
      .orderBy(asc(runLogs.id));

    const events = logs.map((l) => l.event);
    expect(events).toContain("output");
    expect(events).toContain("progress");
  });
});
