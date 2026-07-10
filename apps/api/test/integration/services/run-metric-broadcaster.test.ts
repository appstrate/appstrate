// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the per-run throttled `run_metric` broadcaster.
 *
 * Covers:
 *   - leading-edge: first call for a run fires NOTIFY immediately
 *   - trailing-edge: bursts within the throttle window collapse to one
 *     trailing emit at window end
 *   - payload shape: org/application/package ids, latest tokenUsage,
 *     `cost_so_far` aggregated from `llm_usage`
 *   - cross-tenant isolation: filter delivery on orgId + applicationId
 *   - lifecycle: `clearRunMetricBroadcastState` removes pending timers
 *   - graceful degradation: missing run row drops the broadcast
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { db, truncateAll } from "../../helpers/db.ts";
import { eventData } from "../../helpers/sse.ts";
import { createTestContext, type TestContext } from "../../helpers/auth.ts";
import { seedAgent, seedRun } from "../../helpers/seed.ts";
import { installPackage } from "../../../src/services/application-packages.ts";
import {
  scheduleRunMetricBroadcast,
  clearRunMetricBroadcastState,
  _resetRunMetricBroadcasterForTests,
} from "../../../src/services/run-metric-broadcaster.ts";
import {
  addSubscriber,
  removeSubscriber,
  initRealtime,
  type RealtimeEvent,
} from "../../../src/services/realtime.ts";
import { llmUsage, runs } from "@appstrate/db/schema";
import { eq, sql } from "drizzle-orm";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const activeSubscribers: string[] = [];
function trackSubscriber(id: string) {
  activeSubscribers.push(id);
}

describe("run-metric-broadcaster (integration)", () => {
  let ctx: TestContext;
  const agentId = "@testorg/metrics-agent";
  let runId: string;

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
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });
    runId = run.id;
  });

  afterEach(() => {
    for (const id of activeSubscribers) removeSubscriber(id);
    activeSubscribers.length = 0;
    _resetRunMetricBroadcasterForTests();
  });

  // ── leading edge ─────────────────────────────────────────

  it("first schedule fires NOTIFY immediately on the leading edge", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-leading";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    // Seed a ledger row so cost_so_far has a known non-zero value
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.0042,
    });

    scheduleRunMetricBroadcast(runId);
    await wait(50); // allow PG NOTIFY round-trip

    expect(send).toHaveBeenCalledTimes(1);
    const evt = send.mock.calls[0]![0]!;
    expect(evt.event).toBe("run_metric");
    expect(evt.data).toMatchObject({
      runId,
      orgId: ctx.orgId,
      applicationId: ctx.defaultAppId,
      packageId: agentId,
      tokenUsage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(eventData(evt, "run_metric").costSoFar).toBeCloseTo(0.0042, 5);
  });

  // ── trailing edge throttling ─────────────────────────────

  it("bursts within the throttle window collapse to one trailing emit", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-burst";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    // Burst — three back-to-back calls. Leading fires immediately;
    // the next two should coalesce into a single trailing emit.
    scheduleRunMetricBroadcast(runId);
    scheduleRunMetricBroadcast(runId);
    scheduleRunMetricBroadcast(runId);

    // Right after the burst — only the leading emit has fired.
    await wait(50);
    expect(send).toHaveBeenCalledTimes(1);

    // After the throttle window closes, the trailing emit fires.
    await wait(300);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("trailing emit reflects state at flush time, not schedule time", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-trailing-state";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    // Leading edge — no ledger row yet → cost_so_far = 0
    scheduleRunMetricBroadcast(runId);
    await wait(50);
    expect(send).toHaveBeenCalledTimes(1);
    expect(eventData(send.mock.calls[0]![0]!, "run_metric").costSoFar).toBe(0);

    // Insert a ledger row + schedule a trailing emit. The trailing
    // emit must re-read the ledger and pick up the new total.
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId,
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.01,
    });
    scheduleRunMetricBroadcast(runId);

    await wait(350);
    expect(send).toHaveBeenCalledTimes(2);
    expect(eventData(send.mock.calls[1]![0]!, "run_metric").costSoFar).toBeCloseTo(0.01, 5);
  });

  // ── tenant isolation ─────────────────────────────────────

  it("does not deliver to subscribers in another org", async () => {
    const sendOurs = mock((_e: RealtimeEvent) => {});
    const sendOther = mock((_e: RealtimeEvent) => {});
    trackSubscriber("sub-ours");
    trackSubscriber("sub-other");

    addSubscriber({
      id: "sub-ours",
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send: sendOurs,
    });
    addSubscriber({
      id: "sub-other",
      filter: { orgId: "intruder-org", applicationId: "intruder-app", isAdmin: true },
      send: sendOther,
    });

    scheduleRunMetricBroadcast(runId);
    await wait(50);

    expect(sendOurs).toHaveBeenCalledTimes(1);
    expect(sendOther).not.toHaveBeenCalled();
  });

  // ── lifecycle ────────────────────────────────────────────

  it("clearRunMetricBroadcastState cancels pending trailing emits", async () => {
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-clear";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
      send,
    });

    scheduleRunMetricBroadcast(runId); // leading fires
    scheduleRunMetricBroadcast(runId); // schedules trailing
    await wait(50);
    expect(send).toHaveBeenCalledTimes(1);

    clearRunMetricBroadcastState(runId);
    await wait(300);
    expect(send).toHaveBeenCalledTimes(1); // trailing was cancelled
  });

  // ── degradation ──────────────────────────────────────────

  it("scheduling for a non-existent run does not throw", async () => {
    // No subscribers needed — the broadcaster reads the run row,
    // sees null, and silently no-ops without firing NOTIFY.
    expect(() => scheduleRunMetricBroadcast("non-existent-run")).not.toThrow();
    await wait(50);
  });

  // ── runs.cost persistence (refresh-mid-run hardening) ──────

  it("persists cost_so_far on the run row so a refresh sees the latest value", async () => {
    // Seed a ledger row so the broadcaster has a non-zero SUM.
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId,
      inputTokens: 200,
      outputTokens: 50,
      costUsd: 0.0123,
    });

    scheduleRunMetricBroadcast(runId);
    await wait(50);

    const [row] = await db
      .select({ cost: runs.cost })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(row?.cost).toBeCloseTo(0.0123, 5);
  });

  it("monotonic guard — a regressed cost_so_far does not overwrite a higher persisted value", async () => {
    // Pre-seed runs.cost with a higher value than the next computed SUM
    // (simulates finalize landing before the throttled trailing emit).
    await db.update(runs).set({ cost: 0.05 }).where(eq(runs.id, runId));

    // Ledger has a smaller cumulative cost.
    await db.insert(llmUsage).values({
      source: "runner",
      orgId: ctx.orgId,
      runId,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    });

    scheduleRunMetricBroadcast(runId);
    await wait(50);

    const [row] = await db
      .select({ cost: runs.cost })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    // The higher pre-existing value must survive — broadcaster never regresses.
    expect(row?.cost).toBeCloseTo(0.05, 5);
  });

  it("zero cost_so_far is a no-op — runs.cost stays null", async () => {
    // No ledger rows → cost_so_far = 0. The guarded UPDATE skips the
    // write so the column stays null until the first non-zero metric
    // (mirrors the existing finalize semantics where cost=0 → null).
    scheduleRunMetricBroadcast(runId);
    await wait(50);

    const [row] = await db
      .select({ cost: runs.cost })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1);
    expect(row?.cost).toBeNull();
  });

  // ── CRIT-07 — the mid-run ledger SUM is org-scoped ──────────
  //
  // `llm_usage.run_id` is caller-suppliable on the proxy path (`X-Run-Id`),
  // so the broadcaster sums the ledger on `(run_id, org_id)` — a row carrying
  // another org's `org_id` must never inflate this run's `cost_so_far`. The
  // composite FK `llm_usage(run_id, org_id) → runs(id, org_id)` (now
  // VALIDATED) additionally rejects such a row at the DB level.

  describe("org-scoped cost aggregation (CRIT-07)", () => {
    it("the DB refuses a cross-tenant ledger row (composite FK)", async () => {
      // Org B tries to attach a ledger row to org A's run — the poisoned
      // shape the pre-fix SUM would have picked up. The validated composite
      // FK has no runs row for (runId of A, orgId of B), so the INSERT
      // itself is rejected. That rejection IS the regression assertion: if
      // the FK is dropped/reverted, this insert succeeds and the org filter
      // below becomes the only line of defence.
      const intruder = await createTestContext({
        orgSlug: "metric-intruder",
        email: "intruder@metric.test",
      });

      const err = await db
        .insert(llmUsage)
        .values({
          source: "runner",
          orgId: intruder.orgId, // org B
          runId, // org A's run
          inputTokens: 999,
          outputTokens: 999,
          costUsd: 99.99,
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      // Drizzle wraps the driver error — the FK name lives on the cause.
      const rootMessage = String(((err as Error).cause as Error | undefined)?.message ?? "");
      expect(rootMessage).toContain("llm_usage_run_id_org_id_fk");
    });

    it("the broadcaster SUM itself excludes a poisoned same-run/foreign-org row (FK bypassed)", async () => {
      // Direct regression for the `(run_id, org_id)` filter, independent of
      // the FK: force the poisoned row past the constraint (FK enforcement is
      // trigger-based; `session_replication_role = replica` skips it — the
      // test role is superuser) exactly as a legacy/pre-FK row would exist,
      // then prove the broadcaster's SUM ignores it. Reverting the org filter
      // in `loadRunMetricPayload` makes this fail with 99.99 leaking in.
      const send = mock((_e: RealtimeEvent) => {});
      const subId = "sub-crit07-poison";
      trackSubscriber(subId);
      addSubscriber({
        id: subId,
        filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
        send,
      });

      const intruder = await createTestContext({
        orgSlug: "metric-poison",
        email: "poison@metric.test",
      });

      // Legitimate spend for run A in its own org.
      await db.insert(llmUsage).values({
        source: "runner",
        orgId: ctx.orgId,
        runId,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
      });

      // Poisoned row: org B's org_id on org A's run_id (proxy source so the
      // per-run runner unique index doesn't interfere; request_id required).
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.insert(llmUsage).values({
          source: "proxy",
          orgId: intruder.orgId,
          runId,
          inputTokens: 9999,
          outputTokens: 9999,
          costUsd: 99.99,
          requestId: `req_${crypto.randomUUID()}`,
        });
      });

      scheduleRunMetricBroadcast(runId);
      await wait(50);

      expect(send).toHaveBeenCalledTimes(1);
      const costSoFar = eventData(send.mock.calls[0]![0]!, "run_metric").costSoFar as number;
      expect(costSoFar).toBeCloseTo(0.001, 5); // never 99.991
    });

    it("cost_so_far for run A never includes another org's spend", async () => {
      const send = mock((_e: RealtimeEvent) => {});
      const subId = "sub-crit07";
      trackSubscriber(subId);
      addSubscriber({
        id: subId,
        filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, runId, isAdmin: true },
        send,
      });

      // Same-org ledger row for run A — the only spend that may count.
      await db.insert(llmUsage).values({
        source: "runner",
        orgId: ctx.orgId,
        runId,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.001,
      });

      // Foreign-org spend on a DIFFERENT run (the composite FK forbids the
      // same-run/foreign-org shape — covered above): must never leak into
      // run A's broadcast or persisted cost.
      const intruder = await createTestContext({
        orgSlug: "metric-foreign",
        email: "foreign@metric.test",
      });
      const foreignAgent = "@metric-foreign/agent";
      await seedAgent({ id: foreignAgent, orgId: intruder.orgId, createdBy: intruder.user.id });
      const foreignRun = await seedRun({
        packageId: foreignAgent,
        orgId: intruder.orgId,
        applicationId: intruder.defaultAppId,
        userId: intruder.user.id,
        status: "running",
      });
      await db.insert(llmUsage).values({
        source: "runner",
        orgId: intruder.orgId,
        runId: foreignRun.id,
        inputTokens: 5000,
        outputTokens: 5000,
        costUsd: 42.42,
      });

      scheduleRunMetricBroadcast(runId);
      await wait(50);

      expect(send).toHaveBeenCalledTimes(1);
      const costSoFar = eventData(send.mock.calls[0]![0]!, "run_metric").costSoFar as number;
      // Only org A's own row — never 42.42 (or 42.421).
      expect(costSoFar).toBeCloseTo(0.001, 5);

      // The persisted mid-run aggregate is equally scoped.
      const [row] = await db
        .select({ cost: runs.cost })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      expect(row?.cost).toBeCloseTo(0.001, 5);
    });
  });

  it("a vanished run drops its throttle entry to bound the in-memory map", async () => {
    // Simulates the edge case where the run row was deleted (or its
    // `package_id` SET NULL by cascade) between the metric event
    // landing and `loadRunMetricPayload` running. The broadcaster
    // must not accumulate a permanent throttle entry — the run will
    // never finalize, so `clearRunMetricBroadcastState` will never
    // be called from the ingestion path either.
    const send = mock((_e: RealtimeEvent) => {});
    const subId = "sub-vanished";
    trackSubscriber(subId);
    addSubscriber({
      id: subId,
      filter: { orgId: ctx.orgId, applicationId: ctx.defaultAppId, isAdmin: true },
      send,
    });

    scheduleRunMetricBroadcast("non-existent-run");
    // Schedule again immediately — if the throttle entry from the
    // first call leaked, this second call would coalesce as a
    // trailing tick. After self-cleanup, the second call should
    // create a fresh entry that ALSO sees no run row and self-
    // cleans, never producing a NOTIFY.
    scheduleRunMetricBroadcast("non-existent-run");

    await wait(80);
    // No SSE delivery — the broadcaster's null-payload guard fires
    // every time, never reaching pg_notify.
    expect(send).not.toHaveBeenCalled();
  });
});
