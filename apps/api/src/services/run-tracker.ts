// SPDX-License-Identifier: Apache-2.0

// Tracks in-flight runs for graceful shutdown and cancellation.
// Cross-instance cancel signaling via PubSub adapter (Redis or local EventEmitter).

import { getPubSub } from "../infra/index.ts";
import { logger } from "../lib/logger.ts";

const CANCEL_CHANNEL = "runs:cancel";
const PUBLISH_MAX_RETRIES = 3;
const PUBLISH_BASE_DELAY_MS = 100;

const inFlight = new Map<string, AbortController>();

export function trackRun(runId: string): AbortController {
  const controller = new AbortController();
  inFlight.set(runId, controller);
  return controller;
}

export function untrackRun(runId: string): void {
  inFlight.delete(runId);
}

export function abortRun(runId: string): void {
  // Local fast-path: abort immediately if running on this instance
  const controller = inFlight.get(runId);
  if (controller) controller.abort();

  // Cross-instance: publish cancel signal with linear backoff retry
  publishCancelWithRetry(runId).catch((err) => {
    logger.error("Failed to publish run cancel after retries", {
      runId,
      retries: PUBLISH_MAX_RETRIES,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function publishCancelWithRetry(runId: string): Promise<void> {
  const pubsub = await getPubSub();
  for (let attempt = 0; attempt < PUBLISH_MAX_RETRIES; attempt++) {
    try {
      await pubsub.publish(CANCEL_CHANNEL, runId);
      return;
    } catch (err) {
      if (attempt === PUBLISH_MAX_RETRIES - 1) throw err;
      logger.warn("Retrying run cancel publish", {
        runId,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      // Linear backoff: 100ms, 200ms, 300ms
      await new Promise((r) => setTimeout(r, PUBLISH_BASE_DELAY_MS * (attempt + 1)));
    }
  }
}

export function getInFlightCount(): number {
  return inFlight.size;
}

/** Subscribe to cancel channel so this instance can abort runs triggered by other instances. */
export async function initCancelSubscriber(): Promise<void> {
  try {
    await (
      await getPubSub()
    ).subscribe(CANCEL_CHANNEL, (runId: string) => {
      const controller = inFlight.get(runId);
      if (controller) {
        logger.info("Aborting run via cross-instance cancel", { runId });
        controller.abort();
      }
    });
  } catch (err) {
    logger.error("Failed to subscribe to run cancel channel", {
      channel: CANCEL_CHANNEL,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Unsubscribe from the cancel channel. Call before draining in-flight runs during shutdown. */
export async function stopCancelSubscriber(): Promise<void> {
  try {
    await (await getPubSub()).unsubscribe(CANCEL_CHANNEL);
    logger.info("Unsubscribed from run cancel channel");
  } catch (err) {
    logger.warn("Error unsubscribing from cancel channel", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Wait for all in-flight runs to complete, up to timeoutMs. Returns true if all drained. */
export async function waitForInFlight(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;

  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return inFlight.size === 0;
}
