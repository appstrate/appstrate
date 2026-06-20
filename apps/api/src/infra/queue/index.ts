// SPDX-License-Identifier: Apache-2.0

import { hasRedis } from "../mode.ts";
import { LocalQueue } from "./local-queue.ts";
import type { JobQueue, JobAddOptions } from "./interface.ts";

export type {
  JobQueue,
  QueueJob,
  JobHandler,
  JobAddOptions,
  CronPattern,
  WorkerOptions,
} from "./interface.ts";
export { PermanentJobError } from "./interface.ts";

/**
 * Whether THIS process executes job handlers. This branch has no worker-role
 * split (no `apps/api/src/worker.ts`), so every process that creates a queue
 * also processes it inline. Restore the `APP_ROLE=api` enqueue-only gate here
 * — and in `createQueue` — when a dedicated worker process lands.
 */
export function queueProcessingEnabled(): boolean {
  return true;
}

/** Create a job queue — BullMQ when Redis is available, in-memory otherwise. */
export async function createQueue<T>(
  name: string,
  defaultJobOptions?: JobAddOptions,
): Promise<JobQueue<T>> {
  if (hasRedis()) {
    const { BullMQQueue } = await import("./bullmq-queue.ts");
    return new BullMQQueue<T>(name, defaultJobOptions);
  }
  return new LocalQueue<T>(name);
}
