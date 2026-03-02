import { closeDb } from "./db.ts";
import { logger } from "./logger.ts";
import { shutdownScheduler } from "../services/scheduler.ts";
import { getInFlightCount, waitForInFlight } from "../services/execution-tracker.ts";
import { shutdownSidecarPool } from "../services/sidecar-pool.ts";

const SHUTDOWN_TIMEOUT_MS = 30_000;

export function createShutdownHandler(setShuttingDown: () => void): () => Promise<void> {
  let called = false;

  return async () => {
    if (called) return;
    called = true;
    setShuttingDown();

    logger.info("Shutdown initiated, stopping scheduler and sidecar pool...");
    shutdownScheduler();
    await shutdownSidecarPool();

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

    logger.info("Closing database connections...");
    await closeDb();

    logger.info("Shutdown complete");
    process.exit(0);
  };
}
