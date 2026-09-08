// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { logger } from "../logger.ts";
import { getEeEnv } from "../env.ts";
import { retryPendingCancellations } from "./org-cancellation.ts";
import { resyncAllStorageEntitlements } from "./storage-entitlement.ts";
import {
  addPricingFaults,
  noPricingFaults,
  sweepLedgerBatch,
  type SweepResult,
} from "./usage-recorder.ts";

/**
 * Periodic billing sweeper — the EE metering consumer.
 *
 * EE consumes the platform's append-only `llm_usage` ledger by serial-`id`
 * cursor: each tick advances a watermark through the settled frontier, claims
 * the platform-provided ("system") rows into `ee_billed_llm_usage`, and
 * debits credits. A failed pass advances nothing and the next tick retries from
 * the last committed id. EE reads the ledger only through
 * `services.usage.list` / `services.usage.settledFrontier`; it never joins the
 * platform DB.
 *
 * Scope:
 *   - Each `sweepLedgerBatch` pass processes at most one batch
 *     (`EE_RECONCILIATION_BATCH_SIZE`). A tick DRAINS consecutive full
 *     batches (up to `MAX_DRAIN_ITERATIONS`) so a backlog is worked down within
 *     the tick instead of trickling one batch per interval; the remainder rides
 *     the next tick.
 *   - Per-replica jitter so multi-replica deployments don't sweep in lockstep.
 *   - The throttled storage-entitlement reconcile, STARTED (not awaited) by the
 *     tick — see {@link maybeResyncEntitlements}.
 *
 * OBSERVABILITY. Every tick emits one structured summary line: this is the money
 * path, and a silent tick is indistinguishable from a dead one. On top of that:
 *   - a head-of-line stall warns on the FIRST occurrence (with the blocking row
 *     id and how long the stall has lasted) and is throttled afterwards — the
 *     previous "every 10th stall" rule meant a first warning only after ~50
 *     minutes at the default cadence. `stalledBelowWatermark` separates the two
 *     kinds: ABOVE the watermark is an ordinary in-flight run at the frontier;
 *     BELOW it is a late-committing row the replay window recovered, which the
 *     sweeper deliberately waits on so it cannot age out of that window;
 *   - `alreadyBilled > 0` (an abnormal re-sweep of already-claimed rows ABOVE
 *     the watermark) is surfaced instead of being silently counted;
 *   - `replayBilled > 0` warns: a row billed for the first time from BELOW the
 *     watermark, i.e. the serial-assignment-vs-commit race caught in the act.
 *     Revenue that the plain cursor would have dropped in silence;
 *   - N consecutive failing ticks escalate from `warn` to `error`.
 *
 * These deliberately do NOT go through `@appstrate/core/telemetry`: that façade
 * exposes a fixed set of platform recorders (run duration, container spawn, LLM
 * latency) with no generic counter/gauge for billing. The shape of the façade is
 * the whole reason, and it is the only reason left: this module is a workspace
 * package, so it resolves the very same `@appstrate/core` instance the platform
 * does and the installed telemetry provider IS the one it would see. A billing
 * counter added to the façade would therefore work from here; until the module
 * contract carries one, structured
 * pino logs are the honest transport.
 *
 * Disable: set `EE_RECONCILIATION_INTERVAL_SECONDS=0`.
 */

let sweeperTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/**
 * The currently-running timer-driven sweep, if any. `shutdown()` awaits it
 * (bounded) after clearing the timer so an in-flight pass finishes cleanly
 * before the DB pool closes, rather than being torn out mid-transaction.
 */
let inFlightSweep: Promise<unknown> | null = null;

/**
 * Head-of-line stall tracking. A single wedged run stalls the global cursor for
 * ALL orgs, so the FIRST stall warns immediately; repeats are throttled to one
 * line every `STALL_LOG_EVERY` ticks so a long legitimate run doesn't spam.
 * Reset the instant a pass makes progress.
 */
let consecutiveStalls = 0;
let stallStartedAt = 0;
const STALL_LOG_EVERY = 10;

/** Consecutive ticks that threw. Escalates to `error` at the threshold. */
let consecutiveFailures = 0;
const ALERT_AFTER_FAILED_TICKS = 3;

/**
 * Max `sweepLedgerBatch` calls per tick when draining a backlog. Bounds a tick
 * to a finite amount of work (`MAX_DRAIN_ITERATIONS × EE_RECONCILIATION_BATCH_SIZE`
 * rows, e.g. 50 × 100 = 5000) so a huge backlog can't turn one tick into an
 * unbounded loop; the remainder rides the next tick.
 */
const MAX_DRAIN_ITERATIONS = 50;

/** Cadence of the fleet-wide storage-entitlement reconcile. */
const ENTITLEMENT_RESYNC_INTERVAL_MS = 60 * 60 * 1000;
let lastEntitlementResyncAt = 0;
let inFlightResync: Promise<unknown> | null = null;

/**
 * Start the periodic billing sweep. No-op if
 * `EE_RECONCILIATION_INTERVAL_SECONDS` is `0` (disabled). Safe to
 * call once at module init — re-entry is guarded.
 */
export function startBillingSweeper(): void {
  if (sweeperTimer !== null) {
    logger.warn("billing sweeper already running");
    return;
  }
  const env = getEeEnv();
  const intervalSec = env.EE_RECONCILIATION_INTERVAL_SECONDS;
  if (intervalSec === 0) {
    logger.info("billing sweeper disabled (EE_RECONCILIATION_INTERVAL_SECONDS=0)");
    return;
  }
  stopped = false;
  logger.info("billing sweeper started", {
    intervalSeconds: intervalSec,
    batchSize: env.EE_RECONCILIATION_BATCH_SIZE,
  });
  scheduleNext(intervalSec);
}

/**
 * Stop the periodic sweep — called from the EE module's `shutdown()`.
 * Idempotent.
 */
export function stopBillingSweeper(): void {
  stopped = true;
  if (sweeperTimer !== null) {
    clearTimeout(sweeperTimer);
    sweeperTimer = null;
  }
}

function scheduleNext(intervalSec: number): void {
  if (stopped) return;
  // Per-replica jitter (±15%) prevents multi-replica deployments from sweeping
  // in lockstep.
  const jitter = 1 + (Math.random() - 0.5) * 0.3;
  const delayMs = Math.round(intervalSec * 1000 * jitter);
  sweeperTimer = setTimeout(() => {
    const pass = runBillingSweepTick().finally(() => {
      if (inFlightSweep === pass) inFlightSweep = null;
      scheduleNext(intervalSec);
    });
    inFlightSweep = pass;
  }, delayMs);
  // Don't keep the event loop alive on shutdown for the trailing tick.
  sweeperTimer.unref?.();
}

/**
 * How long {@link drainBillingSweeper} waits for in-flight work at shutdown.
 * Covers a full drain tick (`MAX_DRAIN_ITERATIONS` batches); the previous 5 s
 * routinely expired mid-pass and let `closeEeDb()` run underneath an open
 * transaction. A constant, not a parameter — every caller passed the default,
 * and a knob nobody turns is a knob that misleads.
 */
const DRAIN_TIMEOUT_MS = 60_000;

/**
 * Await the in-flight timer-driven work — the sweep, plus the entitlement
 * reconcile the tick may have started. Called from `shutdown()` AFTER
 * `stopBillingSweeper()` clears the timer, so no new pass starts while this
 * drains. Best-effort: on timeout it returns and lets shutdown proceed (a wedged
 * pass rolls back on its own, losing nothing; the reconcile is an idempotent
 * rewrite the next boot repeats).
 *
 * RE-READS AFTER EVERY WAIT. A single snapshot taken at entry was wrong by
 * construction: the tick STARTS the reconcile from inside the very promise the
 * snapshot is awaiting, so a drain entered mid-sweep saw `inFlightResync === null`,
 * returned the moment the sweep finished, and `closeEeDb()` ran under a reconcile
 * that had begun in between. Looping until both handles are null is what makes
 * "awaits the in-flight work" true rather than merely intended.
 */
export async function drainBillingSweeper(): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const pending = [inFlightSweep, inFlightResync].filter(
      (p): p is Promise<unknown> => p !== null,
    );
    if (pending.length === 0) return;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      Promise.all(pending).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!finished) return;
  }
}

/**
 * Start the fleet-wide storage-entitlement reconcile when the throttle window
 * has elapsed and no pass is already running.
 *
 * Returns immediately — the pass is deliberately NOT awaited. That is the whole
 * coupling fix: `scheduleNext` runs off this tick's completion, so awaiting a
 * fleet-wide reconcile here (one platform write per org, concurrency-bounded
 * inside the pass) would delay the next billing sweep by however long the
 * reconcile takes. `drainBillingSweeper()` still waits for it at shutdown, so
 * the DB pool is never pulled out from under an in-flight projection.
 *
 * A failed pass just retries at the next window: the write is an idempotent
 * blind rewrite, so there is nothing to recover — only to repeat.
 */
function maybeResyncEntitlements(): void {
  if (inFlightResync !== null) return;
  if (Date.now() - lastEntitlementResyncAt < ENTITLEMENT_RESYNC_INTERVAL_MS) return;
  lastEntitlementResyncAt = Date.now();

  const pass = resyncAllStorageEntitlements()
    .then((result) => {
      // Per-org errors are swallowed inside the pass, so a run where EVERY org
      // failed still resolves normally — `failed` is the only signal that the
      // pass repaired nothing.
      if (result.failed > 0) {
        logger.error("storage entitlement resync left orgs unrepaired", { ...result });
      } else if (result.synced > 0 || result.skipped > 0) {
        logger.info("storage entitlement resync pass complete", { ...result });
      }
    })
    .catch((err: unknown) => {
      logger.error("storage entitlement resync pass crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      if (inFlightResync === pass) inFlightResync = null;
    });
  inFlightResync = pass;
}

/**
 * One scheduled tick: the sweep, then the throttled entitlement reconcile
 * (started, not awaited), plus the failure accounting the timer path needs.
 * Never throws — a failing tick is a logged event, not an unhandled rejection.
 * Exported so tests and ops jobs can drive the failure-escalation path directly.
 */
export async function runBillingSweepTick(): Promise<SweepResult | null> {
  let result: SweepResult | null = null;
  try {
    result = await runBillingSweep();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    const fields = {
      error: err instanceof Error ? err.message : String(err),
      consecutiveFailures,
    };
    if (consecutiveFailures >= ALERT_AFTER_FAILED_TICKS) {
      logger.error("billing sweep has failed on consecutive ticks — usage is NOT being billed", {
        ...fields,
        alertAfter: ALERT_AFTER_FAILED_TICKS,
      });
    } else {
      logger.warn("billing sweep tick failed — retrying next tick", fields);
    }
  }

  maybeResyncEntitlements();

  // Cancellations `onOrgDelete` could not confirm with Stripe. Steady state is
  // zero rows and zero work; a row means a customer may still be charged for an
  // organization that no longer exists, so it is retried every tick. Awaited
  // (unlike the fleet-wide reconcile): it touches only the accounts that are
  // actually pending, which is normally none.
  try {
    await retryPendingCancellations();
  } catch (err) {
    logger.error("retrying pending Stripe cancellations failed — will retry next tick", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}

/**
 * Run a single sweep pass-set. Exported so tests + ops jobs can invoke it
 * directly without waiting for the timer. THROWS on failure — the tick wrapper
 * ({@link runBillingSweepTick}) owns the retry/alert accounting.
 *
 * Drains a backlog WITHIN the tick: `sweepLedgerBatch` processes at most one
 * batch (`EE_RECONCILIATION_BATCH_SIZE`) per call, so a single pass per tick
 * caps throughput at `batchSize / interval` rows (e.g. 100 / 300 s = 1200 rows/h)
 * and lets a backlog grow unboundedly. Instead we keep sweeping while the last
 * pass filled its batch AND made cursor progress, bounded by
 * `MAX_DRAIN_ITERATIONS`. The loop stops on a short batch (ledger drained) or a
 * head-of-line stall (`stalledOnId` set) — a stalled pass would just re-read the
 * same wedged row forever. The returned `SweepResult` is the LAST pass, so the
 * stall/backlog accounting below runs once per tick, not once per drained batch.
 */
export async function runBillingSweep(): Promise<SweepResult> {
  const env = getEeEnv();
  const batchSize = env.EE_RECONCILIATION_BATCH_SIZE;

  let result = await sweepLedgerBatch(batchSize);
  let iterations = 1;
  let totalProcessed = result.processed;
  let totalBilled = result.billed;
  let totalAlreadyBilled = result.alreadyBilled;
  let totalReplayed = result.replayed;
  let totalReplayBilled = result.replayBilled;
  let totalOrphanedOrgs = result.orphanedOrgs;
  let totalPricing = addPricingFaults(noPricingFaults(), result.pricing);

  while (
    result.processed >= batchSize &&
    // Cursor progress, which this loop's contract has always claimed but never
    // checked. It is load-bearing now that each pass also re-reads the replay
    // window: a pass that bills only below the watermark leaves the cursor
    // exactly where it was, and looping on it would re-read the same rows until
    // the iteration cap on every tick.
    result.cursorTo > result.cursorFrom &&
    result.stalledOnId === null &&
    iterations < MAX_DRAIN_ITERATIONS
  ) {
    result = await sweepLedgerBatch(batchSize);
    iterations++;
    totalProcessed += result.processed;
    totalBilled += result.billed;
    totalAlreadyBilled += result.alreadyBilled;
    totalReplayed += result.replayed;
    totalReplayBilled += result.replayBilled;
    totalOrphanedOrgs += result.orphanedOrgs;
    totalPricing = addPricingFaults(totalPricing, result.pricing);
  }

  // One structured heartbeat per tick — a tick that logs nothing is
  // indistinguishable from a sweeper that stopped running. A watermark
  // (`cursorTo`) that does not move across ticks is the "billing is behind"
  // signal; no extra platform round-trip is taken to restate it.
  const drainedToCeiling = result.processed >= batchSize;
  // Which KIND of stall, if any. The two have different diagnoses and the id
  // alone does not tell them apart: ABOVE the watermark is the ordinary case —
  // an in-flight run sitting at the frontier. BELOW it means the replay window
  // caught a row that committed late, and the sweeper is deliberately holding
  // the watermark so that row cannot age out of the window before it settles.
  // Derived, not carried: `cursorFrom === cursorTo` whenever a stall is
  // reported, so no extra state is needed.
  const stalledBelowWatermark =
    result.stalledOnId === null ? null : result.stalledOnId <= result.cursorFrom;

  logger.info("billing sweep tick complete", {
    iterations,
    processed: totalProcessed,
    billed: totalBilled,
    alreadyBilled: totalAlreadyBilled,
    // `replayed` proves the below-watermark window is being scanned at all (a
    // steady 0 on a live ledger means replay is off); `replayBilled` is what it
    // actually caught — see the warning below.
    replayed: totalReplayed,
    replayBilled: totalReplayBilled,
    orphanedOrgs: totalOrphanedOrgs,
    // Rows claimed but not charged at their true price. Each pass already logged
    // its own `error` line naming the orgs; restating the counts here keeps the
    // one-line-per-tick summary honest about what was NOT collected.
    partialPriced: totalPricing.partial,
    unpriced: totalPricing.unpriced,
    unknownPriced: totalPricing.unknown,
    cursorTo: result.cursorTo,
    stalledOnId: result.stalledOnId,
    stalledBelowWatermark,
    backlogRemains: drainedToCeiling,
  });

  if (iterations > 1 && drainedToCeiling) {
    // The last pass still filled its batch: we hit the iteration cap and a
    // backlog remains for the next tick.
    logger.warn("billing sweep hit the drain cap — backlog remains for the next tick", {
      iterations,
      totalProcessed,
      batchSize,
      maxIterations: MAX_DRAIN_ITERATIONS,
    });
  }

  if (totalReplayBilled > 0) {
    // A row that was billed for the FIRST time from below the watermark. Its id
    // was taken before the watermark passed, but it only became visible after —
    // the serial-assignment-vs-commit race. Without the replay window this row
    // would never have been read again: unbilled, unlogged, gone.
    //
    // So this is not an error, it is the fix WORKING — and it is the only
    // evidence that the race is live in this deployment. `warn` deliberately: an
    // operator should see it and know real revenue was recovered, without it
    // paging as a fault.
    logger.warn("billing sweep billed a ledger row from BELOW the watermark (replay window)", {
      replayBilled: totalReplayBilled,
      replayed: totalReplayed,
      replayWindow: env.EE_RECONCILIATION_REPLAY_WINDOW,
      cursorTo: result.cursorTo,
    });
  }

  if (totalAlreadyBilled > 0) {
    // Scoped to rows ABOVE the previous watermark, which have by definition
    // never been read before — so a non-zero count still means a re-seeded
    // cursor or two overlapping sweepers. It deliberately does NOT count the
    // replay window, where re-reading claimed rows happens on every tick by
    // design: including them would make this warning permanent, and a money-path
    // warning that always fires is worse than no warning at all.
    logger.warn("billing sweep re-read already-claimed ledger rows", {
      alreadyBilled: totalAlreadyBilled,
      cursorTo: result.cursorTo,
    });
  }

  // Head-of-line stall: the first unread ledger row is an unsettled system row
  // (a wedged run), so the cursor cannot advance for ANY tenant.
  if (result.stalledOnId !== null) {
    consecutiveStalls++;
    if (consecutiveStalls === 1) stallStartedAt = Date.now();
    if (consecutiveStalls === 1 || consecutiveStalls % STALL_LOG_EVERY === 0) {
      logger.warn(
        stalledBelowWatermark
          ? // Distinct message, because the operator response differs: this row
            // is one the replay window recovered, and the sweeper is holding the
            // watermark on purpose so it cannot age out before it settles.
            // Nothing to repair — check that the run behind it is progressing.
            "billing sweep stalled on an unsettled row BELOW the watermark (replay window holding for it)"
          : "billing sweep stalled on an unsettled head-of-line row",
        {
          blockingLlmUsageId: result.stalledOnId,
          stalledBelowWatermark,
          consecutiveStalls,
          stalledForSeconds: Math.round((Date.now() - stallStartedAt) / 1000),
          cursorAt: result.cursorTo,
        },
      );
    }
  } else {
    consecutiveStalls = 0;
    stallStartedAt = 0;
  }

  return result;
}

/**
 * Test helper — reset internal state between cases. Production code
 * calls `start`/`stop` exactly once.
 */
export function _resetBillingSweeperForTests(): void {
  if (sweeperTimer !== null) {
    clearTimeout(sweeperTimer);
    sweeperTimer = null;
  }
  stopped = false;
  consecutiveStalls = 0;
  stallStartedAt = 0;
  consecutiveFailures = 0;
  inFlightSweep = null;
  lastEntitlementResyncAt = 0;
  inFlightResync = null;
}
