// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded workload-stop before terminal finalization.
 *
 * The cancel route and the stall watchdog used to fire `stopByRunId(runId)`
 * fire-and-forget and immediately synthesise the terminal state + close the
 * sink. If the container/microVM/remote daemon is slow or wedged, the run was
 * marked terminal and its sink closed while the workload kept executing with
 * live credentials until the host timeout — a credential-exposure window.
 *
 * This helper AWAITS the stop with a bounded timeout so the common case
 * finalizes only AFTER the workload is actually stopped (ack). It never throws
 * and never blocks indefinitely: on stop failure or timeout it logs and returns
 * so the caller can still force the terminal (forced expiry) rather than leak a
 * run stuck in `running`. That preserves liveness while closing the window in
 * the overwhelming majority of cancels/stalls where the stop completes quickly.
 */

import { getOrchestrator } from "./orchestrator/index.ts";
import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

/** Default bound on how long finalize waits for the workload stop to ack. */
export const STOP_ACK_TIMEOUT_MS = 10_000;

/**
 * Stop the run's workload and wait (bounded) for the stop to complete.
 * Resolves `true` when the stop acknowledged within the timeout, `false` when
 * it failed or timed out (caller should force-finalize). Never rejects.
 */
export async function stopWorkloadAndWait(
  runId: string,
  timeoutMs: number = STOP_ACK_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const stop = getOrchestrator()
      .stopByRunId(runId)
      .then(() => "stopped" as const)
      .catch((err) => {
        logger.warn("stopWorkloadAndWait: workload stop failed; will force-finalize", {
          runId,
          error: getErrorMessage(err),
        });
        return "failed" as const;
      });
    const outcome = await Promise.race([stop, timeout]);
    if (outcome === "timeout") {
      logger.warn("stopWorkloadAndWait: workload stop did not ack in time; force-finalizing", {
        runId,
        timeoutMs,
      });
      // Leave the stop promise running in the background so a slow-but-eventual
      // stop still reclaims the workload; we just no longer block finalize on it.
      void stop;
      return false;
    }
    return outcome === "stopped";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
