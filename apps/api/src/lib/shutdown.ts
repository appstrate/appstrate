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
import { stopRunWatchdog } from "../services/run-watchdog.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";
import { stopUploadGc } from "../services/uploads.ts";

const SHUTDOWN_TIMEOUT_MS = 30_000;

export function createShutdownHandler(setShuttingDown: () => void): () => Promise<void> {
  let called = false;

  return async () => {
    if (called) return;
    called = true;
    setShuttingDown();

    logger.info("Shutdown initiated, stopping sidecar pool...");
    stopUploadGc();
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

    logger.info("Shutting down schedule worker...");
    await shutdownScheduleWorker();

    logger.info("Shutting down inline compaction worker...");
    await shutdownInlineCompactionWorker();

    logger.info("Shutting down modules...");
    await shutdownModules();

    logger.info("Closing database and infrastructure connections...");
    await shutdownInfra();
    const closeOps: Promise<void>[] = [closeDb()];
    if (hasRedis()) {
      const { closeRedis } = await import("./redis.ts");
      closeOps.push(closeRedis());
    }
    await Promise.all(closeOps);

    logger.info("Shutdown complete");
    process.exit(0);
  };
}
