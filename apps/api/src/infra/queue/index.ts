// SPDX-License-Identifier: Apache-2.0

import { hasRedis } from "../mode.ts";
import { LocalQueue } from "./local-queue.ts";
import type { JobQueue, JobAddOptions } from "./interface.ts";

export type { JobQueue, QueueJob } from "./interface.ts";
export { PermanentJobError } from "./interface.ts";

/** Create a job queue — BullMQ when Redis is available, in-memory otherwise. */
export async function createQueue<T>(
  name: string,
  defaultJobOptions?: JobAddOptions,
): Promise<JobQueue<T>> {
  if (hasRedis()) {
    const { BullMQQueue } = await import("./bullmq-queue.ts");
    return new BullMQQueue<T>(name, defaultJobOptions);
  }
  // `defaultJobOptions` reaches BOTH implementations. Dropping them here left
  // every Redis-less deployment (Tier 0/1 — the documented self-hosting
  // default) running the queues at `attempts: 1`: a webhook delivery whose
  // first POST hit a transient 503 was abandoned on a queue configured for 8
  // attempts with custom backoff, and `add("deliver", …)` passes no per-job
  // options to make up for it.
  return new LocalQueue<T>(name, defaultJobOptions);
}
