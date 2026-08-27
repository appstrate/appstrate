// SPDX-License-Identifier: Apache-2.0

/**
 * Durable retry path for `llm_usage` PROXY writes.
 *
 * Provider bytes may already be consumed when metering runs (especially SSE),
 * so a transient Postgres failure cannot be repaired by retrying the LLM call.
 * Failed proxy ledger writes are therefore handed to the platform queue:
 * Redis-backed in production, local in-memory in embedded single-instance mode.
 * A proxy job replays a stable request_id, so the retry is idempotent, and the
 * replayed row gets a FRESH serial id above any cursor watermark — it is billed
 * whenever it eventually lands, even long after its run is terminal.
 *
 * Runner rows are deliberately NOT eligible for the queue. They are cumulative
 * snapshots into a single per-run row that stops being writable the moment the
 * run settles (`llm-usage-ledger.ts`), so an asynchronous replay could only ever
 * land on a row a billing consumer already claimed — raising a total nobody
 * re-reads, i.e. silent under-billing. A failed runner write instead propagates:
 * on the `appstrate.metric` ingestion path it rolls back the surrounding
 * transaction (the sequence is not advanced, the runner re-POSTs the event and
 * its next cumulative snapshot supersedes the lost one), and on the finalize
 * path it keeps the run unsettled until its terminal snapshot is durable.
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

/**
 * Only proxy rows are queue-eligible (see the module doc), so a queued job
 * always replays through the proxy dedup mode — the write mode travels with the
 * job so the consumer never has to re-derive it from the entry.
 */
type RetryConflictMode = "proxy-idempotent";

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
 * The error PROPAGATES instead of being enqueued when either:
 *   - the entry is a `runner` row — an asynchronous replay of a cumulative
 *     snapshot can only land after the run settled, where it is refused (see
 *     the module doc). The caller's transaction rolls back / finalize is
 *     retried, which is the correct recovery for a cumulative producer;
 *   - the caller passed `required` (run finalization's terminal barrier), so a
 *     run can never become settled while its authoritative snapshot is not yet
 *     visible in Postgres.
 *
 * Proxy rows keep the durable queue: each is an immutable per-call fact that
 * receives a fresh serial id when it lands, so a late replay is still billed.
 */
export async function recordLlmUsageReliably(
  entry: LlmUsageEntry,
  opts: RecordLlmUsageOptions & { required?: boolean } = {},
): Promise<void> {
  try {
    await recordLlmUsage(entry, opts);
    return;
  } catch (directError) {
    if (opts.required || entry.source === "runner") throw directError;

    try {
      await (
        await getQueue()
      ).add(
        "persist-usage",
        { entry, onConflict: "proxy-idempotent" },
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
      // `AggregateError.errors` IS the preservation mechanism here: both caught
      // errors are carried in it, in full, and both are also logged one line
      // above. `preserve-caught-error` only recognises the `cause` option, so it
      // reads this as a discard. Adding `{ cause: queueError }` would duplicate
      // `errors[1]` and assert that the enqueue failure caused the direct-write
      // failure — it did not. They are two independent attempts at the same
      // write, which is the exact shape AggregateError exists to express.
      // eslint-disable-next-line preserve-caught-error -- see above: both caught errors are in `.errors`
      throw new AggregateError(
        [directError, queueError],
        "llm_usage persistence and durable retry enqueue both failed",
      );
    }
  }
}

async function closeQueue(graceMs?: number): Promise<void> {
  await usageRetryQueue?.shutdown(graceMs);
  usageRetryQueue = null;
}

export async function shutdownLlmUsageRetryWorker(): Promise<void> {
  // Production grace: a row 500ms into backoff when SIGTERM arrives is billable
  // traffic, and the queue's default budget lets its remaining attempts run.
  await closeQueue();
}

/**
 * Test-only reset for files that create the queue lifecycle explicitly.
 *
 * Zero grace, deliberately. This queue is process-global: under a full-suite
 * run the jobs sleeping between attempts here were enqueued by OTHER test
 * files — a ledger row whose org was truncated out from under it retries every
 * 500ms/1s/2s/4s/8s and never succeeds. Inheriting the production budget makes
 * a test's own teardown block on that foreign work until it times out. A test
 * owns nothing it has not already asserted, so it waits for nothing.
 */
export async function _resetLlmUsageRetryWorkerForTests(): Promise<void> {
  await closeQueue(0);
}
