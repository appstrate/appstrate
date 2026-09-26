// SPDX-License-Identifier: Apache-2.0

// Readiness = orchestrator `initialize()` has succeeded once. A transient boot failure must not
// pin `/health` degraded for the process lifetime, so it is retried in the background; a
// backend that stays broken keeps throwing and stays degraded.

import type { RunOrchestrator } from "@appstrate/core/platform-types";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import { retryInBackground, type RetryInBackgroundOptions } from "../../lib/retry-in-background.ts";

let ready = false;

/** Awaits the first initialize() attempt; never throws. On failure, retries in the background until one succeeds. */
export async function initializeAgentRuntime(
  orchestrator: Pick<RunOrchestrator, "initialize">,
  retry: Partial<RetryInBackgroundOptions> = {},
): Promise<void> {
  const init = async (): Promise<void> => {
    await orchestrator.initialize();
    ready = true;
  };
  try {
    await init();
  } catch (err) {
    logger.warn("Could not initialize container orchestrator — retrying in background", {
      error: getErrorMessage(err),
    });
    retryInBackground("Container orchestrator initialize", init, {
      initialDelayMs: 5_000,
      ...retry,
    });
  }
}

export function isAgentRuntimeReady(): boolean {
  return ready;
}

export function _resetAgentRuntimeReadinessForTesting(): void {
  ready = false;
}
