// SPDX-License-Identifier: Apache-2.0

/**
 * Agent-runtime readiness — whether the run orchestrator has come up.
 *
 * A transient failure of `initialize()` at boot (Docker daemon restarting, a
 * GHCR pull hiccup, the Firecracker runner not up yet) must not pin `/health`
 * degraded for the process lifetime, so a failed first attempt is retried in
 * the background with capped exponential backoff. Readiness means
 * "`initialize()` has succeeded at least once"; a backend that stays broken
 * keeps throwing and therefore stays degraded.
 */

import type { RunOrchestrator } from "@appstrate/core/platform-types";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

const DEFAULT_INITIAL_DELAY_MS = 5_000;
const DEFAULT_MAX_DELAY_MS = 60_000;

export interface AgentRuntimeRecoveryOptions {
  /** Delay before the first retry. Default 5_000. */
  initialDelayMs?: number;
  /** Backoff ceiling. Default 60_000. */
  maxDelayMs?: number;
}

interface RecoveryChain {
  stopped: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

let ready = false;
let chain: RecoveryChain | null = null;

/** Awaits the first initialize() attempt. Never throws. On failure, schedules background retries. */
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

/** True once any initialize() attempt has succeeded. */
export function isAgentRuntimeReady(): boolean {
  return ready;
}

/**
 * Cancels the pending retry; an attempt still in flight is ignored when it
 * settles. Does not wait for it. Idempotent.
 */
export function stopAgentRuntimeRecovery(): void {
  if (!chain) return;
  chain.stopped = true;
  clearTimeout(chain.timer);
  chain = null;
}

/** Test-only: clear timer + all module state. */
export function _resetAgentRuntimeReadinessForTesting(): void {
  stopAgentRuntimeRecovery();
  ready = false;
}
