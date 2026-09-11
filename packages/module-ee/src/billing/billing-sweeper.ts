// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import { logger } from "../logger.ts";
import { getEeEnv } from "../env.ts";
import { retryPendingCancellations } from "./org-cancellation.ts";
import { resyncAllStorageEntitlements } from "./storage-entitlement.ts";
import {
  addPricingFaults,
  noPricingFaults,
  sweepLedgerBatch,
  type CursorSeedResult,
  type SweepResult,
} from "./usage-recorder.ts";
import { getPlatformServices } from "../platform.ts";

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
 *   - The MAINTENANCE half of the tick — see {@link runMaintenance} — which
 *     outlives a paused sweep.
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
 * These ride structured pino logs, not `@appstrate/core/telemetry`: that façade
 * exposes a fixed set of platform recorders with no generic counter or gauge a
 * billing counter could use.
 *
 * Pause METERING: set `EE_RECONCILIATION_INTERVAL_SECONDS=0`. The timer keeps
 * running at {@link MAINTENANCE_INTERVAL_SECONDS} — see {@link runMaintenance}.
 */

let sweeperTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

/**
 * The currently-running timer-driven tick, if any — a full sweep tick, or the
 * maintenance-only tick when metering is paused. `shutdown()` awaits it
 * (bounded) after clearing the timer so an in-flight pass finishes cleanly
 * before the DB pool closes, rather than being torn out mid-transaction.
 */
let inFlightTick: Promise<unknown> | null = null;

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

/**
 * Tick cadence when `EE_RECONCILIATION_INTERVAL_SECONDS=0` pauses metering. Its own, not a
 * fallback: {@link runMaintenance} is idempotent and, in steady state, one empty indexed SELECT.
 */
const MAINTENANCE_INTERVAL_SECONDS = 300;

/** Cadence of the fleet-wide storage-entitlement reconcile. */
const ENTITLEMENT_RESYNC_INTERVAL_MS = 60 * 60 * 1000;
let lastEntitlementResyncAt = 0;
let inFlightResync: Promise<unknown> | null = null;

/**
 * Refuse to resume a watermark the sweeper abandoned — the enable → disable →
 * re-enable gap.
 *
 * The watermark outlives a window with the module off while the platform keeps
 * appending to `llm_usage`, so the first tick after re-enabling would claim the
 * whole gap against TODAY's quotas — irreversibly, the claim table is never
 * purged. Billing it or forgiving it is a commercial decision, so the module
 * refuses to boot and the thrown message names both actions.
 *
 * THE PREDICATE IS DELIBERATELY TWO-PART — each half alone has a false positive
 * that would brick a healthy boot. Age alone refuses a platform that was merely
 * SHUT DOWN for a week (no sweep ran, but no usage accrued either); backlog
 * alone refuses a deployment whose sweep is honestly behind while ticking
 * normally, which needs capacity rather than an operator. Together they say:
 * the sweeper was not running, AND a gap it cannot drain in one tick piled up
 * while it wasn't.
 *
 * A stalled sweeper is not caught here, and must not be: an unsettled `system`
 * row pins `settledFrontier()` at the same place it pins the watermark, so the
 * backlog stays ~0 however long the stall lasts. That is the head-of-line
 * warning's job, not this one's.
 */
export async function assertCursorResumable(cursor: CursorSeedResult): Promise<void> {
  const env = getEeEnv();
  // Metering is paused on purpose: no sweep is about to resume over anything.
  // The gap keeps growing and is checked at the boot that un-pauses it.
  if (env.EE_RECONCILIATION_INTERVAL_SECONDS === 0) return;
  if (env.EE_RECONCILIATION_MAX_GAP_SECONDS === 0) return;

  // Cheap half first: a fresh watermark needs no ledger read at all. A cursor
  // seeded by THIS boot is `defaultNow()`, so the cutover path falls out here.
  const absentSeconds = Math.floor((Date.now() - cursor.updatedAt.getTime()) / 1000);
  if (absentSeconds <= env.EE_RECONCILIATION_MAX_GAP_SECONDS) return;

  const frontierId = await getPlatformServices().usage.settledFrontier();
  const backlog = frontierId - cursor.lastLlmUsageId;
  // One tick's full drain capacity: below it the next tick clears the gap by
  // itself, which is the ordinary catch-up this must not interrupt.
  const drainCapacity = MAX_DRAIN_ITERATIONS * env.EE_RECONCILIATION_BATCH_SIZE;
  if (backlog <= drainCapacity) return;

  throw new Error(
    `The billing sweep last confirmed its watermark ${Math.floor(absentSeconds / 3600)}h ago ` +
      `and ${backlog} settled ledger rows have accumulated since ` +
      `(watermark ${cursor.lastLlmUsageId}, settled frontier ${frontierId}). ` +
      `Resuming would bill that whole gap against the organizations' CURRENT quotas. ` +
      `Choose explicitly — forgive the gap with \`DELETE FROM ee_billing_cursor;\`, which makes ` +
      `the next boot re-seed the watermark AND floor_id at the settled frontier exactly as the ` +
      `original cutover did, so no row below it is ever read again; or bill it by setting ` +
      `EE_RECONCILIATION_MAX_GAP_SECONDS above ${absentSeconds} (0 disables this check). ` +
      `Either way, organizations created while the sweep was absent have no ee_billing_accounts ` +
      `row — the sweep names each one, repair with \`bun run repair:account\`.`,
  );
}

/**
 * Start the periodic worker. `EE_RECONCILIATION_INTERVAL_SECONDS=0` pauses the
 * METERING sweep only — see {@link runMaintenance}. Re-entry is guarded.
 */
export function startBillingSweeper(): void {
  if (sweeperTimer !== null) {
    logger.warn("billing sweeper already running");
    return;
  }
  const env = getEeEnv();
  const intervalSec = env.EE_RECONCILIATION_INTERVAL_SECONDS;
  stopped = false;

  if (intervalSec === 0) {
    logger.info(
      "billing metering paused (EE_RECONCILIATION_INTERVAL_SECONDS=0) — maintenance tick still running",
      { intervalSeconds: MAINTENANCE_INTERVAL_SECONDS },
    );
    scheduleNext(MAINTENANCE_INTERVAL_SECONDS, runMaintenance);
    return;
  }

  logger.info("billing sweeper started", {
    intervalSeconds: intervalSec,
    batchSize: env.EE_RECONCILIATION_BATCH_SIZE,
  });
  scheduleNext(intervalSec, runBillingSweepTick);
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

function scheduleNext(intervalSec: number, tick: () => Promise<unknown>): void {
  if (stopped) return;
  // Per-replica jitter (±15%) prevents multi-replica deployments from sweeping
  // in lockstep.
  const jitter = 1 + (Math.random() - 0.5) * 0.3;
  const delayMs = Math.round(intervalSec * 1000 * jitter);
  sweeperTimer = setTimeout(() => {
    const pass = tick().finally(() => {
      if (inFlightTick === pass) inFlightTick = null;
      scheduleNext(intervalSec, tick);
    });
    inFlightTick = pass;
  }, delayMs);
  // Don't keep the event loop alive on shutdown for the trailing tick.
  sweeperTimer.unref?.();
}

/**
 * How long {@link drainBillingSweeper} waits for in-flight work at shutdown: a full drain
 * tick, since a timeout expiring mid-pass lets `closeEeDb()` run under an open transaction.
 */
const DRAIN_TIMEOUT_MS = 60_000;

/**
 * Await the in-flight timer-driven work — the tick, plus the entitlement
 * reconcile it may have started. Called from `shutdown()` AFTER
 * `stopBillingSweeper()` clears the timer, so no new pass starts while this
 * drains. Best-effort: on timeout it returns and lets shutdown proceed (a wedged
 * pass rolls back on its own, losing nothing; the reconcile is an idempotent
 * rewrite the next boot repeats).
 *
 * RE-READS AFTER EVERY WAIT, because the tick starts the reconcile from inside the very
 * promise this is awaiting: a single snapshot would return the moment the sweep finished,
 * letting `closeEeDb()` run under a reconcile that began in between.
 */
export async function drainBillingSweeper(): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const pending = [inFlightTick, inFlightResync].filter((p): p is Promise<unknown> => p !== null);
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
 * The half of a tick that is NOT metering, and therefore keeps its own timer
 * when `EE_RECONCILIATION_INTERVAL_SECONDS=0` pauses the sweep: the throttled
 * entitlement reconcile, and the retry of every Stripe cancellation
 * `onOrgDelete` could not confirm. A pending cancellation means a customer is
 * still being charged for an organization that is gone — pausing metering must
 * not make that permanent.
 *
 * Never throws: on the timer path there is no caller left to catch it.
 */
async function runMaintenance(): Promise<void> {
  maybeResyncEntitlements();

  // Awaited because steady state is zero rows and one indexed SELECT.
  try {
    await retryPendingCancellations();
  } catch (err) {
    logger.error("retrying pending Stripe cancellations failed — will retry next tick", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * One scheduled tick when metering is on: the sweep, then {@link runMaintenance},
 * plus the failure accounting the timer path needs.
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

  await runMaintenance();

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
    // Cursor progress — load-bearing because each pass also re-reads the replay
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
    // Rows claimed but not charged at their true price; each pass logs the orgs.
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
  inFlightTick = null;
  lastEntitlementResyncAt = 0;
  inFlightResync = null;
}
