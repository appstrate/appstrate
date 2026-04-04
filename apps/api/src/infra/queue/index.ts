// SPDX-License-Identifier: Apache-2.0

import { hasRedis } from "../mode.ts";
import { BullMQQueue } from "./bullmq-queue.ts";
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

/** Create a job queue — BullMQ when Redis is available, in-memory otherwise. */
export function createQueue<T>(name: string, defaultJobOptions?: JobAddOptions): JobQueue<T> {
  if (hasRedis()) {
    return new BullMQQueue<T>(name, defaultJobOptions);
  }
  return new LocalQueue<T>(name);
}
