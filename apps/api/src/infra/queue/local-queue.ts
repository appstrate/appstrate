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
import { computeNextRun } from "../../lib/cron.ts";
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
  /**
   * Last time this scheduler fired a job (epoch ms). Prevents double-firing
   * within a window. Initialised to the registration time so no occurrence
   * before the scheduler existed is replayed on process (re)start.
   */
  lastFiredAt: number;
}

/** Cron poll cadence (ms). The evaluator runs on this interval. */
const CRON_POLL_INTERVAL_MS = 30_000;

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
      // Anchor at registration time so the first poll's window never reaches
      // back before the scheduler existed — an occurrence that fell just
      // before startup/registration is not replayed on (re)start.
      lastFiredAt: Date.now(),
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

    // Evaluate cron schedulers every poll interval
    this.cronInterval = setInterval(() => this.evaluateCron(), CRON_POLL_INTERVAL_MS);

    // Neither timer should keep the event loop alive on its own — the server
    // listener does that in prod, and this lets the test process exit cleanly.
    this.drainInterval.unref?.();
    this.cronInterval.unref?.();

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
   * Cron evaluator — fires any scheduler whose next computed run falls within
   * the current poll window. Uses `computeNextRun` (cron-parser) so validation
   * (`isValidCron`) and execution share one parser: presets (`@daily`),
   * aliases (`MON`), and 6-field expressions all behave identically.
   *
   * `computeNextRun` is forward-looking — it always returns a time strictly
   * after its base. To detect a run that should have fired during the window
   * we ending now, we compute the next run from `(now - pollWindow)` as the
   * base and fire when that run is `<= now`. `lastFiredAt` bounds the base so a
   * scheduler can't re-fire the same occurrence on overlapping/late polls.
   */
  private evaluateCron(): void {
    if (this.shuttingDown || !this.handler) return;

    const now = Date.now();
    const windowStart = now - CRON_POLL_INTERVAL_MS;
    for (const scheduler of this.schedulers.values()) {
      // Base the forward-looking lookup at the window start, but never before
      // the last fire so we don't replay an occurrence already enqueued.
      const base = Math.max(windowStart, scheduler.lastFiredAt);
      const next = computeNextRun(scheduler.pattern, scheduler.tz, new Date(base));
      if (!next || next.getTime() > now) continue;

      scheduler.lastFiredAt = now;
      const id = `cron_${scheduler.id}_${now}`;
      const job: QueueJob<T> = {
        id,
        name: scheduler.jobTemplate.name,
        data: scheduler.jobTemplate.data,
        attemptsMade: 0,
      };
      this.pending.push({ job });
      logger.debug(`${this.name} cron fired`, { schedulerId: scheduler.id });
    }
    this.drain();
  }
}
