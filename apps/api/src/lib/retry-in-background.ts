// SPDX-License-Identifier: Apache-2.0

import { logger } from "./logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export interface RetryInBackgroundOptions {
  initialDelayMs: number;
  maxDelayMs?: number;
  level?: "warn" | "error";
  signal?: AbortSignal;
}

/**
 * Retries `attempt` until it resolves once: sleeps initialDelayMs, doubling up to maxDelayMs,
 * with unref'd timers. The caller has already made (and logged) the first attempt. Never throws.
 */
export function retryInBackground(
  what: string,
  attempt: () => Promise<void>,
  options: RetryInBackgroundOptions,
): void {
  const { initialDelayMs, maxDelayMs = 60_000, level = "warn", signal } = options;
  void (async () => {
    for (let n = 1, delayMs = initialDelayMs; ; n++, delayMs = Math.min(delayMs * 2, maxDelayMs)) {
      // Unref'd: a pending retry must never hold the process (or a test run) open.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs).unref?.();
      });
      if (signal?.aborted) return;
      try {
        await attempt();
        logger.info(`${what} recovered after retry`, { attempts: n });
        return;
      } catch (err) {
        logger[level](`${what} retry failed`, {
          error: getErrorMessage(err),
          attempt: n,
          nextDelayMs: Math.min(delayMs * 2, maxDelayMs),
        });
      }
    }
  })();
}
