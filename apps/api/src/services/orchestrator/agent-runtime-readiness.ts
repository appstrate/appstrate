// SPDX-License-Identifier: Apache-2.0

// Ready once orchestrator `initialize()` has succeeded; a backend that stays broken stays degraded.

import type { RunOrchestrator } from "@appstrate/core/platform-types";
import { retryUntilSuccess, type RetryUntilSuccessOptions } from "../../lib/retry-until-success.ts";

let ready = false;

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
