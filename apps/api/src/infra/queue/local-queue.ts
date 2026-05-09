// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory job queue implementation.
 * Suitable for single-instance self-hosted deployments.
 *
 * - Jobs are lost on restart (no persistence).
 * - Cron scheduling is evaluated every 30 seconds.
 * - Retry with backoff via setTimeout.
 */

import { logger } from "../../lib/logger.ts";
import type {
  JobQueue,
  JobHandler,
  QueueJob,
  JobAddOptions,
  CronPattern,
  WorkerOptions,
} from "./interface.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { PermanentJobError } from "./interface.ts";

interface PendingJob<T> {
  job: QueueJob<T>;
  opts?: JobAddOptions;
}

interface CronScheduler<T> {
  id: string;
  pattern: string;
  tz: string;
  jobTemplate: { name: string; data: T };
}

export class LocalQueue<T> implements JobQueue<T> {
  private pending: PendingJob<T>[] = [];
  private schedulers = new Map<string, CronScheduler<T>>();
  private handler: JobHandler<T> | null = null;
  private workerOpts: WorkerOptions | null = null;
  private activeJobs = 0;
  private cronInterval: ReturnType<typeof setInterval> | null = null;
  private drainInterval: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;

  constructor(private readonly name: string) {}

  async add(name: string, data: T, opts?: JobAddOptions): Promise<string> {
    const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: QueueJob<T> = { id, name, data, attemptsMade: 0 };
    this.pending.push({ job, opts });
    this.drain();
    return id;
  }

  async upsertScheduler(
    schedulerId: string,
    pattern: CronPattern,
    jobTemplate: { name: string; data: T },
  ): Promise<void> {
    this.schedulers.set(schedulerId, {
      id: schedulerId,
      pattern: pattern.pattern,
      tz: pattern.tz ?? "UTC",
      jobTemplate,
    });
  }

  async removeScheduler(schedulerId: string): Promise<void> {
    this.schedulers.delete(schedulerId);
  }

  process(handler: JobHandler<T>, opts?: WorkerOptions): void {
    if (this.handler) return;
    this.handler = handler;
    this.workerOpts = opts ?? null;

    // Drain pending jobs every 500ms
    this.drainInterval = setInterval(() => this.drain(), 500);

    // Evaluate cron schedulers every 30s
    this.cronInterval = setInterval(() => this.evaluateCron(), 30_000);

    // Drain any jobs that were added before the worker started
    this.drain();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.cronInterval) clearInterval(this.cronInterval);
    if (this.drainInterval) clearInterval(this.drainInterval);
    this.cronInterval = null;
    this.drainInterval = null;

    // Wait for active jobs to finish (max 10s)
    const deadline = Date.now() + 10_000;
    while (this.activeJobs > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private drain(): void {
    if (!this.handler || this.shuttingDown) return;
    const maxConcurrency = this.workerOpts?.concurrency ?? 5;

    while (this.pending.length > 0 && this.activeJobs < maxConcurrency) {
      const item = this.pending.shift()!;
      this.executeJob(item.job, item.opts);
    }
  }

  private executeJob(job: QueueJob<T>, opts?: JobAddOptions): void {
    if (!this.handler) return;
    this.activeJobs++;

    const handler = this.handler;
    const maxAttempts = opts?.attempts ?? 1;
    const backoffStrategy = this.workerOpts?.backoffStrategy;

    const run = async (currentJob: QueueJob<T>): Promise<void> => {
      try {
        await handler(currentJob);
      } catch (err) {
        if (err instanceof PermanentJobError) {
          logger.warn(`${this.name} job permanently failed`, {
            jobId: currentJob.id,
            error: err.message,
          });
          return;
        }

        const nextAttempt = currentJob.attemptsMade + 1;
        if (nextAttempt < maxAttempts) {
          const delay = backoffStrategy ? backoffStrategy(nextAttempt) : 1000 * nextAttempt;
          logger.warn(`${this.name} job failed, retrying in ${delay}ms`, {
            jobId: currentJob.id,
            attempt: nextAttempt,
            error: getErrorMessage(err),
          });
          // Schedule retry — await a timer so the outer .finally() waits
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              const retryJob: QueueJob<T> = { ...currentJob, attemptsMade: nextAttempt };
              run(retryJob).then(resolve, resolve);
            }, delay);
          });
          return;
        }

        logger.error(`${this.name} job failed after ${maxAttempts} attempts`, {
          jobId: currentJob.id,
          error: getErrorMessage(err),
        });
      }
    };

    run(job).finally(() => {
      this.activeJobs--;
      this.drain();
    });
  }

  /**
   * Simple cron evaluator — checks if any scheduler should fire.
   * Uses a minute-granularity check against the current time.
   */
  private evaluateCron(): void {
    if (this.shuttingDown || !this.handler) return;

    const now = new Date();
    for (const scheduler of this.schedulers.values()) {
      if (this.shouldFire(scheduler.pattern, scheduler.tz, now)) {
        const id = `cron_${scheduler.id}_${Date.now()}`;
        const job: QueueJob<T> = {
          id,
          name: scheduler.jobTemplate.name,
          data: scheduler.jobTemplate.data,
          attemptsMade: 0,
        };
        this.pending.push({ job });
        logger.debug(`${this.name} cron fired`, { schedulerId: scheduler.id });
      }
    }
    this.drain();
  }

  /**
   * Check if a cron expression should fire for the current minute.
   * Supports standard 5-field cron: minute hour dom month dow.
   */
  private shouldFire(cronExpr: string, tz: string, now: Date): boolean {
    try {
      // Get current time in the target timezone
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "numeric",
        day: "numeric",
        month: "numeric",
        weekday: "short",
        hour12: false,
      })
        .formatToParts(now)
        .reduce(
          (acc, p) => {
            acc[p.type] = p.value;
            return acc;
          },
          {} as Record<string, string>,
        );

      const minute = parseInt(parts.minute ?? "0");
      const hour = parseInt(parts.hour ?? "0");
      const day = parseInt(parts.day ?? "1");
      const month = parseInt(parts.month ?? "1");
      const dowMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      const dow = dowMap[parts.weekday ?? "Sun"] ?? 0;

      const fields = cronExpr.trim().split(/\s+/);
      if (fields.length < 5) return false;

      return (
        this.matchField(fields[0]!, minute, 0, 59) &&
        this.matchField(fields[1]!, hour, 0, 23) &&
        this.matchField(fields[2]!, day, 1, 31) &&
        this.matchField(fields[3]!, month, 1, 12) &&
        this.matchField(fields[4]!, dow, 0, 6, true)
      );
    } catch {
      return false;
    }
  }

  // Match a single cron field against a value. Supports *, star/N, N-M, comma lists.
  // For day-of-week: normalizes 7 → 0 (both represent Sunday in standard cron).
  private matchField(
    field: string,
    value: number,
    _min: number,
    _max: number,
    isDow = false,
  ): boolean {
    if (field === "*") return true;

    return field.split(",").some((part) => {
      // Step: */N or N-M/S
      const [range, stepStr] = part.split("/");
      const step = stepStr ? parseInt(stepStr) : undefined;

      if (range === "*" && step) {
        return value % step === 0;
      }

      // Range: N-M — normalize 7 → 0 for day-of-week bounds
      if (range!.includes("-")) {
        let [lo, hi] = range!.split("-").map(Number);
        if (isDow) {
          if (lo === 7) lo = 0;
          if (hi === 7) hi = 0;
        }
        if (step) {
          return value >= lo! && value <= hi! && (value - lo!) % step === 0;
        }
        return value >= lo! && value <= hi!;
      }

      // Exact value — normalize 7 → 0 for day-of-week
      let parsed = parseInt(range!);
      if (isDow && parsed === 7) parsed = 0;
      return parsed === value;
    });
  }
}
