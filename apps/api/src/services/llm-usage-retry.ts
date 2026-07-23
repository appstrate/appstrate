// SPDX-License-Identifier: Apache-2.0

/**
 * Durable retry path for `llm_usage` writes.
 *
 * Provider bytes may already be consumed when metering runs (especially SSE),
 * so a transient Postgres failure cannot be repaired by retrying the LLM call.
 * Failed ledger writes are therefore handed to the platform queue: Redis-backed
 * in production, local in-memory in embedded single-instance mode. Proxy jobs
 * replay a stable request_id and runner jobs use their monotonic run upsert, so
 * every retry is idempotent.
 */

import { createQueue, type JobQueue } from "../infra/queue/index.ts";
import { logger } from "../lib/logger.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import {
  recordLlmUsage,
  type LlmUsageEntry,
  type RecordLlmUsageOptions,
} from "./llm-usage-ledger.ts";

const QUEUE_NAME = "llm-usage-retry";
const RETRY_ATTEMPTS = 288; // five-minute cap => roughly 24 hours of retries
const MAX_BACKOFF_MS = 5 * 60_000;

type RetryConflictMode = NonNullable<RecordLlmUsageOptions["onConflict"]>;

interface LlmUsageRetryJob {
  entry: LlmUsageEntry;
  onConflict: RetryConflictMode;
}

let usageRetryQueue: JobQueue<LlmUsageRetryJob> | null = null;

async function getQueue(): Promise<JobQueue<LlmUsageRetryJob>> {
  if (!usageRetryQueue) {
    usageRetryQueue = await createQueue<LlmUsageRetryJob>(QUEUE_NAME, {
      attempts: RETRY_ATTEMPTS,
      backoff: { type: "custom" },
      removeOnComplete: 1000,
      // Keep terminal failures for operator inspection/replay. The queue-level
      // retention remains bounded while a 24h outage does not silently erase
      // the evidence.
      removeOnFail: 5000,
    });
  }
  return usageRetryQueue;
}

function retryBackoff(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempt - 1, 10));
}

/**
 * Start the retry consumer and verify that its backing queue is reachable.
 * Boot awaits this: accepting billable traffic with no recovery channel would
 * recreate the silent-loss window this worker exists to close.
 */
export async function initLlmUsageRetryWorker(): Promise<void> {
  const queue = await getQueue();
  queue.process(
    async (job) => {
      await recordLlmUsage(job.data.entry, { onConflict: job.data.onConflict });
    },
    { concurrency: 4, backoffStrategy: retryBackoff },
  );
  await queue.count();
}

/**
 * Persist a ledger entry, durably enqueueing it when the direct write fails.
 *
 * `required` is used by run finalization: the terminal runner snapshot must be
 * visible in Postgres before the run becomes settled, otherwise Cloud could
 * claim an older cumulative row and never revisit its serial id. In that one
 * path we propagate the DB error so finalize is retried and the run remains
 * unsettled. Every other path may safely enqueue because its context is still
 * active or the proxy row will receive a fresh serial id when replayed.
 */
export async function recordLlmUsageReliably(
  entry: LlmUsageEntry,
  opts: RecordLlmUsageOptions & { required?: boolean } = {},
): Promise<void> {
  try {
    await recordLlmUsage(entry, opts);
    return;
  } catch (directError) {
    if (opts.required) throw directError;

    const onConflict: RetryConflictMode =
      opts.onConflict ?? (entry.source === "runner" ? "runner-monotonic" : "proxy-idempotent");
    try {
      await (
        await getQueue()
      ).add(
        "persist-usage",
        { entry, onConflict },
        { attempts: RETRY_ATTEMPTS, backoff: { type: "custom" } },
      );
      logger.warn("Queued llm_usage write after direct persistence failure", {
        source: entry.source,
        orgId: entry.orgId,
        runId: entry.runId ?? null,
        requestId: entry.requestId ?? null,
        error: getErrorMessage(directError),
      });
    } catch (queueError) {
      logger.error("Failed to persist or enqueue llm_usage", {
        source: entry.source,
        orgId: entry.orgId,
        runId: entry.runId ?? null,
        requestId: entry.requestId ?? null,
        directError: getErrorMessage(directError),
        queueError: getErrorMessage(queueError),
      });
      throw new AggregateError(
        [directError, queueError],
        "llm_usage persistence and durable retry enqueue both failed",
      );
    }
  }
}

export async function shutdownLlmUsageRetryWorker(): Promise<void> {
  await usageRetryQueue?.shutdown();
  usageRetryQueue = null;
}

/** Test-only reset for files that create the queue lifecycle explicitly. */
export async function _resetLlmUsageRetryWorkerForTests(): Promise<void> {
  await shutdownLlmUsageRetryWorker();
}
