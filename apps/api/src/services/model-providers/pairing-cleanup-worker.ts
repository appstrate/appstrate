// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth model provider pairing cleanup worker.
 *
 * Periodically deletes rows from `model_provider_pairings` whose
 * `expires_at` is more than a grace window in the past (see
 * `cleanupExpiredPairings`). Pure table-bloat janitor — unrelated to
 * token refresh, hence its own worker decoupled from
 * `OAUTH_REFRESH_WORKER_ENABLED`.
 *
 * Queue/scheduler names are preserved from the legacy refresh-worker
 * implementation so operators who previously had the refresh worker
 * enabled don't end up with orphaned BullMQ schedulers in Redis after
 * the split.
 */

import { createQueue, type JobQueue, type QueueJob } from "../../infra/queue/index.ts";
import { logger } from "../../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { cleanupExpiredPairings } from "./pairings.ts";

const PAIRING_CLEANUP_QUEUE_NAME = "oauth-model-pairing-cleanup";

/**
 * Pairings have a 5-minute TTL + a 1-hour grace window before deletion,
 * so a 15-minute sweep keeps the table tail bounded without thrashing.
 */
const PAIRING_CLEANUP_CRON = "*/15 * * * *";
const PAIRING_CLEANUP_SCHEDULER_ID = "oauth-model-pairing-cleanup";

type CleanupJobData = Record<string, never>;

let pairingCleanupQueue: JobQueue<CleanupJobData> | null = null;

async function getPairingCleanupQueue(): Promise<JobQueue<CleanupJobData>> {
  if (!pairingCleanupQueue)
    pairingCleanupQueue = await createQueue<CleanupJobData>(PAIRING_CLEANUP_QUEUE_NAME);
  return pairingCleanupQueue;
}

async function handlePairingCleanupJob(_job: QueueJob<CleanupJobData>): Promise<void> {
  const startedAt = Date.now();
  try {
    const deleted = await cleanupExpiredPairings();
    logger.info("oauth_model_pairing_cleanup_done", {
      deleted,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error("oauth_model_pairing_cleanup_failed", {
      error: getErrorMessage(err),
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Initialize the OAuth model provider pairing cleanup worker. Idempotent. */
export async function initPairingCleanupWorker(): Promise<void> {
  const queue = await getPairingCleanupQueue();
  queue.process(handlePairingCleanupJob, { concurrency: 1 });
  await queue.upsertScheduler(
    PAIRING_CLEANUP_SCHEDULER_ID,
    { pattern: PAIRING_CLEANUP_CRON, tz: "UTC" },
    { name: "cleanup", data: {} },
  );
  logger.info("OAuth model pairing cleanup worker initialized", {
    pairingCleanupCron: PAIRING_CLEANUP_CRON,
  });
}

/** Shutdown the worker. Idempotent. */
export async function shutdownPairingCleanupWorker(): Promise<void> {
  await pairingCleanupQueue?.shutdown();
  pairingCleanupQueue = null;
  logger.info("OAuth model pairing cleanup worker stopped");
}
