// SPDX-License-Identifier: Apache-2.0

import { closeDb } from "@appstrate/db/client";
import { closeRedis } from "./redis.ts";
import { logger } from "./logger.ts";
import { shutdownInfra } from "../infra/index.ts";
import { hasRedis } from "../infra/mode.ts";
import { shutdownScheduleWorker } from "../services/scheduler.ts";
import { shutdownWebhookWorker } from "../services/webhooks.ts";
import {
  getInFlightCount,
  waitForInFlight,
  stopCancelSubscriber,
} from "../services/run-tracker.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";

const SHUTDOWN_TIMEOUT_MS = 30_000;

export function createShutdownHandler(setShuttingDown: () => void): () => Promise<void> {
  let called = false;

  return async () => {
    if (called) return;
    called = true;
    setShuttingDown();

    logger.info("Shutdown initiated, stopping scheduler, webhook worker, and sidecar pool...");
    await Promise.all([shutdownScheduleWorker(), shutdownWebhookWorker()]);
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

    logger.info("Closing database and infrastructure connections...");
    await shutdownInfra();
    const closeOps: Promise<void>[] = [closeDb()];
    if (hasRedis()) closeOps.push(closeRedis());
    await Promise.all(closeOps);

    logger.info("Shutdown complete");
    process.exit(0);
  };
}
