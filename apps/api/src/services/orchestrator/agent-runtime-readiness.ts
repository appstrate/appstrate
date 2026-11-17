// SPDX-License-Identifier: Apache-2.0

// Ready once orchestrator `initialize()` has succeeded; a backend that stays broken stays degraded.

import type { RunOrchestrator } from "@appstrate/core/platform-types";
import { retryUntilSuccess, type RetryUntilSuccessOptions } from "../../lib/retry-until-success.ts";
import { ApiError } from "../../lib/errors.ts";

let ready = false;
let runCapacityReady = false;

export function initializeAgentRuntime(
  orchestrator: Pick<RunOrchestrator, "initialize">,
  retry: Partial<RetryUntilSuccessOptions> = {},
): Promise<void> {
  return retryUntilSuccess(
    "Container orchestrator initialize",
    async () => {
      await orchestrator.initialize();
      ready = true;
    },
    { initialDelayMs: 5_000, ...retry },
  );
}

export function isAgentRuntimeReady(): boolean {
  return ready;
}

export function _resetAgentRuntimeReadinessForTesting(): void {
  ready = false;
}

/**
 * Run-capacity readiness: the boot's orphan pass (stop + finalize, resource
 * cleanup) and the runtime's FIRST `initialize()` attempt are done. It is NOT
 * "the runtime is healthy" — a failed `initialize()` still sets it, and runs
 * go through and fail visibly exactly as before. Until it is set the runtime
 * has not been initialised (images not yet pulled, no runner handshake) and the
 * orphan sweep is still reclaiming resources, so every launch door refuses via
 * {@link assertRunCapacityReady}. The orphan pass itself spares a fresh run (it
 * takes only runs without a recent heartbeat, and keeps running containers).
 */
export function markRunCapacityReady(): void {
  runCapacityReady = true;
}

export function isRunCapacityReady(): boolean {
  return runCapacityReady;
}

export function _resetRunCapacityReadyForTesting(): void {
  runCapacityReady = false;
}

/** Refuse a launch while the boot's run-capacity phase is still running. Throws before any write. */
export function assertRunCapacityReady(): void {
  if (runCapacityReady) return;
  throw new ApiError({
    status: 503,
    code: "run_capacity_starting",
    title: "Service Unavailable",
    detail:
      "Run execution is still starting up (orphan cleanup and runtime initialisation); retry in a few seconds.",
    headers: { "Retry-After": "5" },
  });
}
