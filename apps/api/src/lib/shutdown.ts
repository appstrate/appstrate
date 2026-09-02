// SPDX-License-Identifier: Apache-2.0

import { closeDb } from "@appstrate/db/client";
import { logger } from "./logger.ts";
import { shutdownInfra } from "../infra/index.ts";
import { shutdownModules } from "./modules/module-loader.ts";
import { hasRedis } from "../infra/mode.ts";
import {
  getInFlightCount,
  waitForInFlight,
  stopCancelSubscriber,
} from "../services/run-tracker.ts";
import { shutdownScheduleWorker } from "../services/scheduler.ts";
import { shutdownInlineCompactionWorker } from "../services/inline-compaction.ts";
import { shutdownOAuthModelRefreshWorker } from "../services/model-providers/refresh-worker.ts";
import { shutdownPairingCleanupWorker } from "../services/model-providers/pairing-cleanup-worker.ts";
import { shutdownLlmUsageRetryWorker } from "../services/llm-usage-retry.ts";
import { drainAudits } from "../services/audit.ts";
import { stopRunWatchdog } from "../services/run-watchdog.ts";
import { stopRuntimeImageWarmer } from "../services/orchestrator/runtime-image-warmer.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { stopUploadGc } from "../services/uploads.ts";
import { stopFileGc } from "../services/files.ts";
import { stopStorageDeletionWorker } from "../services/storage-deletion.ts";
import { shutdownTelemetry } from "@appstrate/core/telemetry";

const SHUTDOWN_TIMEOUT_MS = 30_000;
/** Cap on flushing tracked audit inserts (`services/audit.ts`) at shutdown. */
const AUDIT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Hard ceiling on the WHOLE shutdown sequence, not just the in-flight drain.
 *
 * Every step below is an unbounded `await` (BullMQ `close()` without `force`
 * waits for the job it is processing; `shutdownModules()` runs third-party
 * code; `shutdownTelemetry()` flushes over the network). Without a deadline a
 * single hung step means the connection teardown and `process.exit(0)` never
 * run, and the supervisor's SIGKILL is what actually ends the process.
 *
 * Must stay BELOW the supervisor's stop grace period, otherwise it can never
 * fire. `docker-compose.yml` sets `stop_grace_period: 45s` on the `appstrate`
 * service for exactly this reason — Docker's default is 10s, which is shorter
 * than the drain above and is what made the teardown unreachable. Operators
 * running outside that compose file (k8s `terminationGracePeriodSeconds`,
 * systemd `TimeoutStopSec`) need the same alignment.
 */
const SHUTDOWN_DEADLINE_MS = 40_000;

export function createShutdownHandler(setShuttingDown: () => void): () => Promise<void> {
  let called = false;

  return async () => {
    if (called) return;
    called = true;
    setShuttingDown();

    const deadline = setTimeout(() => {
      logger.error("Shutdown deadline exceeded — forcing exit", {
        deadlineMs: SHUTDOWN_DEADLINE_MS,
        inFlight: getInFlightCount(),
      });
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    // Never hold the event loop open on the timer itself: if every step
    // completes the process exits below anyway. `unref` only stops the timer
    // from KEEPING an idle loop alive — a loop hung on a pending await is not
    // idle, so the deadline still fires in the case it exists to cover.
    deadline.unref();

    logger.info("Shutdown initiated, stopping container orchestrator...");
    stopUploadGc();
    stopFileGc();
    stopStorageDeletionWorker();
    await getOrchestrator().shutdown();

    // Unsubscribe from cancel channel before draining to avoid processing
    // stale cancel messages during shutdown
    await stopCancelSubscriber();

    const inFlight = getInFlightCount();
    if (inFlight > 0) {
      logger.info("Waiting for in-flight runs", {
        count: inFlight,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      });
      const drained = await waitForInFlight(SHUTDOWN_TIMEOUT_MS);
      if (!drained) {
        logger.warn("Shutdown timeout reached, forcing exit", {
          remaining: getInFlightCount(),
        });
      }
    }

    logger.info("Stopping run watchdog...");
    await stopRunWatchdog();

    // The pin containers themselves are durable and deliberately survive
    // this process — only the sweep timer stops.
    stopRuntimeImageWarmer();

    logger.info("Shutting down schedule worker...");
    await shutdownScheduleWorker();

    logger.info("Shutting down inline compaction worker...");
    await shutdownInlineCompactionWorker();

    logger.info("Shutting down OAuth model refresh worker...");
    await shutdownOAuthModelRefreshWorker();

    logger.info("Shutting down OAuth model pairing cleanup worker...");
    await shutdownPairingCleanupWorker();

    logger.info("Shutting down LLM usage retry worker...");
    await shutdownLlmUsageRetryWorker();

    // Audit inserts are taken off the response path (the MCP router hands
    // them to `trackAudit` instead of awaiting them), so the trail's
    // survival across a recycle is guaranteed HERE: after in-flight runs and
    // workers (nothing new is being audited), before the modules and the DB
    // connection go away. Bounded — a wedged insert must not hold the
    // deadline hostage.
    logger.info("Draining pending audit inserts...");
    const audits = await drainAudits(AUDIT_DRAIN_TIMEOUT_MS);
    if (audits.drained) {
      logger.info("Audit inserts drained", { count: audits.pending });
    } else {
      logger.warn("Audit drain timed out — some audit rows may be lost", {
        pending: audits.pending,
        timeoutMs: AUDIT_DRAIN_TIMEOUT_MS,
      });
    }

    logger.info("Shutting down modules...");
    await shutdownModules();

    // Flush any buffered spans/metrics before the process exits. INVARIANT:
    // this runs AFTER in-flight runs are drained (above) and AFTER worker
    // shutdown, so the terminal-status counters + run-duration histograms those
    // paths emit are already recorded — and it is `await`ed, so the buffered
    // BatchSpanProcessor + PeriodicExportingMetricReader actually flush before
    // the DB/Redis teardown below races the event loop to exit. Keep this
    // ordering: flush last among the telemetry-producing teardown steps, but
    // before the connection close + `process.exit(0)`.
    await shutdownTelemetry();

    logger.info("Closing database and infrastructure connections...");
    await shutdownInfra();
    const closeOps: Promise<void>[] = [closeDb()];
    if (hasRedis()) {
      const { closeRedis } = await import("./redis.ts");
      closeOps.push(closeRedis());
    }
    await Promise.all(closeOps);

    clearTimeout(deadline);
    logger.info("Shutdown complete");
    process.exit(0);
  };
}
