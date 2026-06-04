// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../lib/logger.ts";
import { getOrchestrator } from "./orchestrator/index.ts";
import { ORPHAN_REAP_INTERVAL_MS } from "./orchestrator/constants.ts";

let reapTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background sweep that reaps stale, non-running managed containers on
 * a fixed interval. Complements the boot-time orphan cleanup: a long-lived API
 * never restarts, so without a periodic sweep the residue of failed launches
 * accumulates until the next deploy. The orchestrator's `reapStaleOrphans` is
 * runtime-safe (only removes terminated/stale containers, never a live run nor
 * any network). Safe to call multiple times — a no-op after the first.
 */
export function startOrphanReaper(): void {
  if (reapTimer) return;
  reapTimer = setInterval(() => {
    getOrchestrator()
      .reapStaleOrphans()
      .then((count) => {
        if (count > 0) logger.info("Reaped stale orphan containers", { count });
      })
      .catch((err) => {
        logger.warn("Periodic orphan reaper sweep failed", {
          error: getErrorMessage(err),
        });
      });
  }, ORPHAN_REAP_INTERVAL_MS);
  // Don't hold the event loop open for this timer alone.
  reapTimer.unref?.();
}

/** Stop the background sweep. Called from the shutdown handler. */
export function stopOrphanReaper(): void {
  if (reapTimer) {
    clearInterval(reapTimer);
    reapTimer = null;
  }
}
