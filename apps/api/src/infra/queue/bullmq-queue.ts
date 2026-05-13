// SPDX-License-Identifier: Apache-2.0

/**
 * BullMQ (Redis) implementation of the JobQueue interface.
 */

import { Queue, Worker, UnrecoverableError } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import type Redis from "ioredis";
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
  private queue: Queue<Record<string, unknown>, unknown, string>;
  private worker: Worker<Record<string, unknown>, unknown, string> | null = null;
  // Owned by THIS queue instance — `worker.close()` disconnects it cleanly
  // without touching the shared publisher. Sharing the global connection
  // with the Worker's blocking client leaked an unhandled
  // "Connection is closed" rejection on shutdown (ioredis flushes the
  // command queue when the socket closes mid-BRPOP), failing bun:test
  // files that exercise a full init→shutdown lifecycle.
  private workerConnection: Redis | null = null;

  constructor(
    private readonly name: string,
    defaultJobOptions?: JobAddOptions,
  ) {
    this.queue = new Queue<Record<string, unknown>, unknown, string>(name, {
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
    const job = await this.queue.add(name, data as Record<string, unknown>, {
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
      { name: jobTemplate.name, data: jobTemplate.data as Record<string, unknown> },
    );
  }

  async removeScheduler(schedulerId: string): Promise<void> {
    await this.queue.removeJobScheduler(schedulerId);
  }

  process(handler: JobHandler<T>, opts?: WorkerOptions): void {
    if (this.worker) return;

    this.workerConnection = getRedisConnection().duplicate();
    // Swallow "Connection is closed" rejections that fire when worker.close()
    // tears down the blocking client mid-BRPOP. Without this, the unhandled
    // rejection escapes BullMQ's run loop in some shutdown timings.
    this.workerConnection.on("error", (err) => {
      if (err.message === "Connection is closed.") return;
      logger.error(`${this.name} worker connection error`, { error: err.message });
    });

    this.worker = new Worker<Record<string, unknown>, unknown, string>(
      this.name,
      async (bullJob) => {
        const job: QueueJob<T> = {
          id: bullJob.id ?? bullJob.name,
          name: bullJob.name,
          data: bullJob.data as T,
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
        connection: this.workerConnection as unknown as ConnectionOptions,
        ...(opts?.concurrency ? { concurrency: opts.concurrency } : {}),
        ...(opts?.limiter ? { limiter: opts.limiter } : {}),
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
    // Ensure the worker's duplicate connection is fully released — BullMQ's
    // worker.close() drains commands but leaves the ioredis socket open in
    // some paths, holding the test process alive past file end.
    if (this.workerConnection && this.workerConnection.status !== "end") {
      await this.workerConnection.quit().catch(() => {});
    }
    this.worker = null;
    this.workerConnection = null;
  }
}
