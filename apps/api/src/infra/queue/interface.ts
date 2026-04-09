// SPDX-License-Identifier: Apache-2.0

/**
 * Abstract job queue interface.
 * Implementations: BullMQ (Redis) and local in-memory.
 */

export interface JobQueue<T> {
  /** Add a one-shot job. Returns job ID. */
  add(name: string, data: T, opts?: JobAddOptions): Promise<string>;

  /**
   * Upsert a repeatable job (cron scheduler).
   * If a scheduler with this ID already exists, it is replaced.
   */
  upsertScheduler(
    schedulerId: string,
    pattern: CronPattern,
    jobTemplate: { name: string; data: T },
  ): Promise<void>;

  /** Remove a repeatable scheduler by ID. Idempotent. */
  removeScheduler(schedulerId: string): Promise<void>;

  /** Start processing jobs with the given handler. */
  process(handler: JobHandler<T>, opts?: WorkerOptions): void;

  /** Graceful shutdown: drain active jobs, close connections. */
  shutdown(): Promise<void>;
}

export type JobHandler<T> = (job: QueueJob<T>) => Promise<void>;

export interface QueueJob<T> {
  readonly id: string;
  readonly name: string;
  readonly data: T;
  readonly attemptsMade: number;
}

export interface JobAddOptions {
  attempts?: number;
  backoff?: { type: "custom" };
  removeOnComplete?: number | boolean;
  removeOnFail?: number | boolean;
}

export interface CronPattern {
  pattern: string;
  tz?: string;
}

export interface WorkerOptions {
  concurrency?: number;
  limiter?: { max: number; duration: number };
  /** Custom backoff strategy: given attempt number (1-based), return delay in ms. */
  backoffStrategy?: (attempt: number) => number;
}

/**
 * Error that signals the job should NOT be retried.
 * Equivalent to BullMQ's UnrecoverableError.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}
