// SPDX-License-Identifier: Apache-2.0

/**
 * Per-run throttled fan-out for `appstrate.metric` events. Sits between
 * the `PersistingEventSink` (which calls
 * {@link scheduleRunMetricBroadcast} on every metric persistence) and
 * Postgres `NOTIFY run_metric` (which the realtime SSE service relays
 * to UI subscribers).
 *
 * Why a separate module — the broadcaster reads
 * `runs (org_id, application_id, package_id)` and aggregates
 * `llm_usage.cost_usd` for the run. Doing that inline in
 * {@link PersistingEventSink} would couple the metric write-through to
 * the broadcast read path (two extra queries inside the ingestion hot
 * path) and force the throttle state into the per-event sink instances
 * that are spun up + dropped per HTTP request. Lifting the throttle
 * map to module scope keeps it stable across requests.
 *
 * Throttle policy — leading + trailing per run:
 *
 *   - first call for a run fires `pg_notify` immediately
 *   - subsequent calls within {@link THROTTLE_WINDOW_MS} land on a
 *     trailing timer that fires once at the end of the window
 *   - the trailing tick always re-runs the read path, so the broadcast
 *     reflects the latest persisted state at flush time (not the value
 *     captured when the timer was scheduled)
 *
 * This matches the streaming-UI state of the art: emit fast on the
 * leading edge for low latency, coalesce bursts on the trailing edge
 * to bound subscriber load. Idle entries are GC'd via {@link clearRunMetricBroadcastState}
 * once the run finalizes (callers in the run-event-ingestion path).
 *
 * Best-effort: failures in the read or NOTIFY path are logged and
 * dropped — the broadcaster never fails the metric ingestion that
 * triggered it. Realtime UX is non-load-bearing relative to the
 * authoritative `runs.cost` value written at finalize.
 */

import { db } from "@appstrate/db/client";
import { runs, llmUsage } from "@appstrate/db/schema";
import { eq, sql } from "drizzle-orm";
import { notifyRunMetric, type RunMetricNotifyPayload } from "@appstrate/db/notify";
import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/**
 * How long after a leading-edge broadcast we coalesce subsequent
 * triggers into a single trailing emit. 250 ms balances UI latency
 * (perceptibly live) with subscriber load under bursty metric
 * emission (a tool-heavy turn can fire 5+ metric events per second).
 */
const THROTTLE_WINDOW_MS = 250;

interface ThrottleState {
  /** Timestamp (ms) of the last fired NOTIFY for this run. */
  lastFiredAt: number;
  /** Pending trailing timer, or null if no broadcast is queued. */
  trailingTimer: ReturnType<typeof setTimeout> | null;
}

const throttleByRunId = new Map<string, ThrottleState>();

/**
 * Schedule a `run_metric` broadcast for the given run. Safe to call on
 * every metric event — the per-run throttle handles coalescing.
 */
export function scheduleRunMetricBroadcast(runId: string): void {
  const state = throttleByRunId.get(runId);
  const now = Date.now();

  if (!state) {
    // First emit ever for this run — fire on the leading edge so the
    // UI sees the first metric immediately.
    throttleByRunId.set(runId, { lastFiredAt: now, trailingTimer: null });
    void fireBroadcast(runId);
    return;
  }

  const elapsed = now - state.lastFiredAt;
  if (elapsed >= THROTTLE_WINDOW_MS && state.trailingTimer === null) {
    // Window has elapsed and no trailing tick is pending — fire now.
    state.lastFiredAt = now;
    void fireBroadcast(runId);
    return;
  }

  // Coalesce — schedule (or keep) a single trailing tick at window end.
  if (state.trailingTimer !== null) return;
  const delay = Math.max(0, THROTTLE_WINDOW_MS - elapsed);
  state.trailingTimer = setTimeout(() => {
    const current = throttleByRunId.get(runId);
    if (!current) return;
    current.trailingTimer = null;
    current.lastFiredAt = Date.now();
    void fireBroadcast(runId);
  }, delay);
  // Don't keep the event loop alive on shutdown for the trailing tick.
  state.trailingTimer.unref?.();
}

/**
 * Drop the throttle state for a run. Call from `finalizeRun` so a run
 * id never leaks past its lifecycle (the in-memory map is otherwise
 * unbounded for long-lived API processes).
 */
export function clearRunMetricBroadcastState(runId: string): void {
  const state = throttleByRunId.get(runId);
  if (state?.trailingTimer) {
    clearTimeout(state.trailingTimer);
  }
  throttleByRunId.delete(runId);
}

/**
 * Test helper — drop ALL throttle state. Production code never calls
 * this; tests use it between cases to keep state isolated.
 */
export function _resetRunMetricBroadcasterForTests(): void {
  for (const state of throttleByRunId.values()) {
    if (state.trailingTimer) clearTimeout(state.trailingTimer);
  }
  throttleByRunId.clear();
}

async function fireBroadcast(runId: string): Promise<void> {
  try {
    const payload = await loadRunMetricPayload(runId);
    if (!payload) {
      // Run vanished (deleted, or `package_id` set to NULL by cascade).
      // Drop the throttle entry so a long-lived API process doesn't
      // accumulate a leak entry per orphaned run id — the run will
      // never finalize and `clearRunMetricBroadcastState` would
      // otherwise never be called for it.
      clearRunMetricBroadcastState(runId);
      return;
    }
    await notifyRunMetric(db, payload);
  } catch (err) {
    logger.warn("run_metric broadcast failed", {
      runId,
      error: getErrorMessage(err),
    });
  }
}

async function loadRunMetricPayload(runId: string): Promise<RunMetricNotifyPayload | null> {
  // Two reads — kept separate because the run row + ledger sum hit
  // different indexes; combining them would force a JOIN on every
  // tick. Both are PK / index lookups, sub-millisecond on healthy
  // PG. The pg_notify is fire-and-forget so the cost is bounded
  // regardless of subscriber count.
  const [runRow] = await db
    .select({
      orgId: runs.orgId,
      applicationId: runs.applicationId,
      packageId: runs.packageId,
      tokenUsage: runs.tokenUsage,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  if (!runRow) return null;
  // `runs.package_id` is `ON DELETE SET NULL`, so an in-flight metric
  // for a run whose package was just deleted hits this branch. The
  // SSE filter on `packageId` would never match anyway — drop the
  // broadcast so subscribers aren't confused by a payload with a
  // missing package id.
  if (!runRow.packageId) return null;

  const [costRow] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${llmUsage.costUsd}), 0)`,
    })
    .from(llmUsage)
    .where(eq(llmUsage.runId, runId));

  return {
    run_id: runId,
    org_id: runRow.orgId,
    application_id: runRow.applicationId,
    package_id: runRow.packageId,
    token_usage: (runRow.tokenUsage as RunMetricNotifyPayload["token_usage"]) ?? null,
    cost_so_far: Number(costRow?.total ?? 0),
  };
}
