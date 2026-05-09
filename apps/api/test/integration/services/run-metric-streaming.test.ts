// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end integration: ingesting an `appstrate.metric` event drives
 * a `run_metric` SSE delivery to a matching subscriber.
 *
 * Combines `PersistingEventSink` (the ingestion hot path) with the
 * realtime LISTEN service to verify the whole pipeline:
 *
 *   PersistingEventSink.persist(metric)
 *     → upsert llm_usage
 *     → scheduleRunMetricBroadcast
 *     → pg_notify('run_metric', ...)
 *     → realtime LISTEN handler
 *     → subscriber.send → SSE frame
 *
 * The unit tests cover each step in isolation; this test guards the
 * boundary contracts between them.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import { PersistingEventSink } from "../../../src/services/run-launcher/appstrate-event-sink.ts";
import {
  addSubscriber,
  removeSubscriber,
  initRealtime,
  type RealtimeEvent,
} from "../../../src/services/realtime.ts";
import { _resetRunMetricBroadcasterForTests } from "../../../src/services/run-metric-broadcaster.ts";
import type { RunEvent } from "@appstrate/afps-runtime/types";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("run_metric end-to-end (event sink → SSE)", () => {
  let ctx: TestContext;
  const agentId = "@testorg/streaming-agent";
  let runId: string;
  const subscriberIds: string[] = [];

  beforeAll(async () => {
    await initRealtime();
  });

  beforeEach(async () => {
    await truncateAll();
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

  afterEach(() => {
    for (const id of subscriberIds) removeSubscriber(id);
    subscriberIds.length = 0;
    _resetRunMetricBroadcasterForTests();
  });

  function metricEvent(usage: Record<string, number>, cost: number): RunEvent {
    return {
      type: "appstrate.metric",
      timestamp: Date.now(),
      runId,
      usage,
      cost,
    } as RunEvent;
  }

  it("a single metric event arrives at a subscribed run-scoped SSE", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const id = "stream-sub-1";
    subscriberIds.push(id);
    addSubscriber({
      id,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });

    await sink.handle(metricEvent({ input_tokens: 100, output_tokens: 50 }, 0.005));
    await wait(80);

    expect(send).toHaveBeenCalledTimes(1);
    const frame = send.mock.calls[0]![0]!;
    expect(frame.event).toBe("run_metric");
    expect(frame.data).toMatchObject({
      runId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: agentId,
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(frame.data.costSoFar).toBeCloseTo(0.005, 5);
  });

  it("subsequent metric events deliver running totals (cost monotonically increases)", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const id = "stream-sub-running";
    subscriberIds.push(id);
    addSubscriber({
      id,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });

    // Three events with monotonically increasing cumulative totals.
    // The throttle window is 250 ms — wait between emits so each one
    // fires (no coalescing of trailing).
    await sink.handle(metricEvent({ input_tokens: 100, output_tokens: 0 }, 0.001));
    await wait(80);
    await wait(300);
    await sink.handle(metricEvent({ input_tokens: 200, output_tokens: 50 }, 0.005));
    await wait(80);
    await wait(300);
    await sink.handle(metricEvent({ input_tokens: 350, output_tokens: 120 }, 0.012));
    await wait(80);

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]!.data.costSoFar).toBeCloseTo(0.001, 5);
    expect(send.mock.calls[1]![0]!.data.costSoFar).toBeCloseTo(0.005, 5);
    expect(send.mock.calls[2]![0]!.data.costSoFar).toBeCloseTo(0.012, 5);
  });

  it("a regressed-cost metric event does not regress costSoFar (monotonic-max upsert)", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const id = "stream-sub-mono";
    subscriberIds.push(id);
    addSubscriber({
      id,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });

    await sink.handle(metricEvent({ input_tokens: 200, output_tokens: 50 }, 0.01));
    await wait(80);
    await wait(300);
    await sink.handle(metricEvent({ input_tokens: 50, output_tokens: 10 }, 0.003));
    await wait(80);

    expect(send).toHaveBeenCalledTimes(2);
    // Both broadcasts must report the higher cost — the second event
    // tried to regress but the upsert kept the higher value.
    expect(send.mock.calls[0]![0]!.data.costSoFar).toBeCloseTo(0.01, 5);
    expect(send.mock.calls[1]![0]!.data.costSoFar).toBeCloseTo(0.01, 5);
  });

  it("does not deliver metric events to subscribers in a different org", async () => {
    const sendOurs = mock((_e: RealtimeEvent) => {});
    const sendOther = mock((_e: RealtimeEvent) => {});
    subscriberIds.push("ours", "other");

    addSubscriber({
      id: "ours",
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send: sendOurs,
    });
    addSubscriber({
      id: "other",
      filter: { orgId: "alien-org", applicationId: "alien-app", isAdmin: true },
      send: sendOther,
    });

    const sink = new PersistingEventSink({
      scope: { orgId: ctx.orgId, applicationId: ctx.defaultAppId },
      runId,
      writeLedger: true,
    });
    await sink.handle(metricEvent({ input_tokens: 1, output_tokens: 1 }, 0.0001));
    await wait(80);

    expect(sendOurs).toHaveBeenCalledTimes(1);
    expect(sendOther).not.toHaveBeenCalled();
  });
});
