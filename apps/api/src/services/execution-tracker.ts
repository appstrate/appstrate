// SPDX-License-Identifier: Apache-2.0

// Tracks in-flight executions for graceful shutdown and cancellation.
// Cross-instance cancel signaling via Redis Pub/Sub.

import { getRedisConnection, getRedisSubscriber } from "../lib/redis.ts";
import { logger } from "../lib/logger.ts";

const CANCEL_CHANNEL = "executions:cancel";
const PUBLISH_MAX_RETRIES = 3;
const PUBLISH_BASE_DELAY_MS = 100;

const inFlight = new Map<string, AbortController>();

export function trackExecution(executionId: string): AbortController {
  const controller = new AbortController();
  inFlight.set(executionId, controller);
  return controller;
}

export function untrackExecution(executionId: string): void {
  inFlight.delete(executionId);
}

export function abortExecution(executionId: string): void {
  // Local fast-path: abort immediately if running on this instance
  const controller = inFlight.get(executionId);
  if (controller) controller.abort();

  // Cross-instance: publish cancel signal with retry
  publishCancelWithRetry(executionId).catch((err) => {
    logger.error("Failed to publish execution cancel to Redis after retries", {
      executionId,
      retries: PUBLISH_MAX_RETRIES,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function publishCancelWithRetry(executionId: string): Promise<void> {
  for (let attempt = 0; attempt < PUBLISH_MAX_RETRIES; attempt++) {
    try {
      await getRedisConnection().publish(CANCEL_CHANNEL, executionId);
      return;
    } catch (err) {
      if (attempt === PUBLISH_MAX_RETRIES - 1) throw err;
      logger.warn("Retrying execution cancel publish", {
        executionId,
        attempt: attempt + 1,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, PUBLISH_BASE_DELAY_MS * (attempt + 1)));
    }
  }
}

export function getInFlightCount(): number {
  return inFlight.size;
}

/** Subscribe to Redis cancel channel so this instance can abort executions triggered by other instances. */
export function initCancelSubscriber(): void {
  const subscriber = getRedisSubscriber();

  subscriber.subscribe(CANCEL_CHANNEL, (err) => {
    if (err) {
      logger.error("Failed to subscribe to execution cancel channel", {
        channel: CANCEL_CHANNEL,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    logger.info("Subscribed to execution cancel channel", {
      channel: CANCEL_CHANNEL,
    });
  });

  subscriber.on("message", (channel, executionId) => {
    if (channel !== CANCEL_CHANNEL) return;

    const controller = inFlight.get(executionId);
    if (controller) {
      logger.info("Aborting execution via cross-instance cancel", {
        executionId,
      });
      controller.abort();
    }
  });
}

/** Unsubscribe from the cancel channel. Call before draining in-flight executions during shutdown. */
export async function stopCancelSubscriber(): Promise<void> {
  try {
    const subscriber = getRedisSubscriber();
    await subscriber.unsubscribe(CANCEL_CHANNEL);
    logger.info("Unsubscribed from execution cancel channel");
  } catch (err) {
    logger.warn("Error unsubscribing from cancel channel", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Wait for all in-flight executions to complete, up to timeoutMs. Returns true if all drained. */
export async function waitForInFlight(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;

  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return inFlight.size === 0;
}
