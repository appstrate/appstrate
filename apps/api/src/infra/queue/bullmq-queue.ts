// SPDX-License-Identifier: Apache-2.0

/**
 * BullMQ (Redis) implementation of the JobQueue interface.
 */

import { Queue, Worker, UnrecoverableError } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { getRedisConnection } from "../../lib/redis.ts";
import { logger } from "../../lib/logger.ts";
import type {
  JobQueue,
  JobHandler,
  QueueJob,
  JobAddOptions,
  CronPattern,
  WorkerOptions,
} from "./interface.ts";
import { PermanentJobError } from "./interface.ts";

export class BullMQQueue<T> implements JobQueue<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queue: Queue<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private worker: Worker<any> | null = null;

  constructor(
    private readonly name: string,
    defaultJobOptions?: JobAddOptions,
  ) {
    this.queue = new Queue(name, {
      connection: getRedisConnection() as unknown as ConnectionOptions,
      ...(defaultJobOptions
        ? {
            defaultJobOptions: {
              attempts: defaultJobOptions.attempts,
              backoff: defaultJobOptions.backoff,
              removeOnComplete: defaultJobOptions.removeOnComplete,
              removeOnFail: defaultJobOptions.removeOnFail,
            },
          }
        : {}),
    });
  }

  async add(name: string, data: T, opts?: JobAddOptions): Promise<string> {
    const job = await this.queue.add(name, data, {
      attempts: opts?.attempts,
      backoff: opts?.backoff,
      removeOnComplete: opts?.removeOnComplete,
      removeOnFail: opts?.removeOnFail,
    });
    return job.id ?? name;
  }

  async upsertScheduler(
    schedulerId: string,
    pattern: CronPattern,
    jobTemplate: { name: string; data: T },
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      schedulerId,
      { pattern: pattern.pattern, tz: pattern.tz ?? "UTC" },
      { name: jobTemplate.name, data: jobTemplate.data },
    );
  }

  async removeScheduler(schedulerId: string): Promise<void> {
    await this.queue.removeJobScheduler(schedulerId);
  }

  process(handler: JobHandler<T>, opts?: WorkerOptions): void {
    if (this.worker) return;

    this.worker = new Worker<T>(
      this.name,
      async (bullJob) => {
        const job: QueueJob<T> = {
          id: bullJob.id ?? bullJob.name,
          name: bullJob.name,
          data: bullJob.data,
          attemptsMade: bullJob.attemptsMade,
        };
        try {
          await handler(job);
        } catch (err) {
          if (err instanceof PermanentJobError) {
            throw new UnrecoverableError(err.message);
          }
          throw err;
        }
      },
      {
        connection: getRedisConnection() as unknown as ConnectionOptions,
        concurrency: opts?.concurrency,
        limiter: opts?.limiter,
        ...(opts?.backoffStrategy
          ? {
              settings: {
                backoffStrategy: (attemptsMade: number) => opts.backoffStrategy!(attemptsMade),
              },
            }
          : {}),
      },
    );

    this.worker.on("failed", (job, err) => {
      if (err instanceof UnrecoverableError) return;
      logger.error(`${this.name} job failed`, {
        jobId: job?.id,
        error: err.message,
      });
    });
  }

  async shutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.worker = null;
  }
}
