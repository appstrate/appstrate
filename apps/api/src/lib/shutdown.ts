import { closeDb } from "./db.ts";
import { closeRedis } from "./redis.ts";
import { logger } from "./logger.ts";
import { shutdownScheduleWorker } from "../services/scheduler.ts";
import {
  getInFlightCount,
  waitForInFlight,
  stopCancelSubscriber,
} from "../services/execution-tracker.ts";
import { getOrchestrator } from "../services/orchestrator/index.ts";

const SHUTDOWN_TIMEOUT_MS = 30_000;

export function createShutdownHandler(setShuttingDown: () => void): () => Promise<void> {
  let called = false;

  return async () => {
    if (called) return;
    called = true;
    setShuttingDown();

    logger.info("Shutdown initiated, stopping scheduler and sidecar pool...");
    await shutdownScheduleWorker();
    await getOrchestrator().shutdown();

    // Unsubscribe from cancel channel before draining to avoid processing
    // stale cancel messages during shutdown
    await stopCancelSubscriber();

    const inFlight = getInFlightCount();
    if (inFlight > 0) {
      logger.info("Waiting for in-flight executions", {
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

    logger.info("Closing database and Redis connections...");
    await Promise.all([closeDb(), closeRedis()]);

    logger.info("Shutdown complete");
    process.exit(0);
  };
}
