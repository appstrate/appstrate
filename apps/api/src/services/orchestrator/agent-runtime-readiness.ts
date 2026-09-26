// SPDX-License-Identifier: Apache-2.0

// Readiness = orchestrator `initialize()` has succeeded once. A transient boot failure must not
// pin `/health` degraded for the process lifetime, so it is retried with capped backoff; a
// backend that stays broken keeps throwing and stays degraded.

import type { RunOrchestrator } from "@appstrate/core/platform-types";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export interface AgentRuntimeRecoveryOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
}

interface RecoveryChain {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let ready = false;
let chain: RecoveryChain | null = null;

/** Awaits the first initialize() attempt; never throws. On failure, retries in the background. */
export function initializeAgentRuntime(
  orchestrator: Pick<RunOrchestrator, "initialize">,
  options: AgentRuntimeRecoveryOptions = {},
): Promise<void> {
  stopAgentRuntimeRecovery();
  const self: RecoveryChain = { stopped: false };
  chain = self;

  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  let delayMs = Math.min(options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS, maxDelayMs);
  let attempts = 0;

  // The next attempt is scheduled only once this one settles, so they never overlap.
  const attempt = async (): Promise<void> => {
    attempts++;
    try {
      await orchestrator.initialize();
    } catch (err) {
      if (self.stopped) return;
      logger.warn("Could not initialize container orchestrator — retrying in background", {
        error: getErrorMessage(err),
        attempt: attempts,
        retryInMs: delayMs,
      });
      self.timer = setTimeout(() => void attempt(), delayMs);
      self.timer.unref?.();
      delayMs = Math.min(delayMs * 2, maxDelayMs);
      return;
    }
    if (self.stopped) return;
    ready = true;
    if (attempts > 1) logger.info("Container orchestrator recovered", { attempts });
  };

  return attempt();
}

export function isAgentRuntimeReady(): boolean {
  return ready;
}

/** Does not wait for an in-flight attempt; its outcome is ignored when it settles. */
export function stopAgentRuntimeRecovery(): void {
  if (!chain) return;
  chain.stopped = true;
  clearTimeout(chain.timer);
  chain = null;
}

export function _resetAgentRuntimeReadinessForTesting(): void {
  stopAgentRuntimeRecovery();
  ready = false;
}
