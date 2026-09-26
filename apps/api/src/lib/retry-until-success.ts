// SPDX-License-Identifier: Apache-2.0

import { logger } from "./logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";

export interface RetryUntilSuccessOptions {
  initialDelayMs: number;
  maxDelayMs?: number;
  level?: "warn" | "error";
  signal?: AbortSignal;
}

/**
 * Awaits the first attempt; on failure retries in the background (delay doubling up to maxDelayMs,
 * unref'd timers) until one succeeds or `signal` aborts before a retry. Never throws.
 */
export async function retryUntilSuccess(
  what: string,
  attempt: () => Promise<void>,
  options: RetryUntilSuccessOptions,
): Promise<void> {
  const { initialDelayMs, maxDelayMs = 60_000, level = "warn", signal } = options;
  try {
    await attempt();
    return;
  } catch (err) {
    logger[level](`${what} failed — retrying in background`, {
      error: getErrorMessage(err),
      retryInMs: initialDelayMs,
    });
  }
  void (async () => {
    for (let n = 1, delayMs = initialDelayMs; ; n++, delayMs = Math.min(delayMs * 2, maxDelayMs)) {
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
