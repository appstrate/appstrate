// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `LocalQueue.shutdown()` and its interaction with retry backoff.
 *
 * A job sleeping between attempts counts as active — its `run()` awaits the
 * retry timer — so shutdown has to decide what to do with it. Both halves of
 * that decision are load-bearing:
 *
 *  - A retry due INSIDE the shutdown budget is work that would have completed.
 *    `llm-usage-retry` puts billable `llm_usage` rows on this queue precisely
 *    because losing one is silent; dropping a row that was 500ms into backoff
 *    when SIGTERM arrived recreates the loss window that worker exists to close.
 *  - A retry due BEYOND the budget cannot finish anyway, and waiting on it pins
 *    shutdown to its full grace period on every restart. It is released — and,
 *    because it is work being thrown away, it is logged.
 *
 * The queue takes its logger by constructor injection, so these assert the log
 * line directly rather than through a global module mock — and, because the
 * queue registers a sleeper on the same synchronous line that logs it, that
 * same injected logger is what these tests wait on to know a retry is parked.
 */

import { describe, it, expect } from "bun:test";
import { LocalQueue } from "../../src/infra/queue/local-queue.ts";
import type { QueueJob } from "../../src/infra/queue/interface.ts";
import type { Logger } from "@appstrate/core/logger";

interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data?: Record<string, unknown>;
}

interface RecordingLogger {
  lines: LogLine[];
  logger: Logger;
  /**
   * Resolves once a line whose message contains `substring` has been emitted —
   * already-recorded lines included, so it cannot miss one it was set up after.
   */
  emitted: (substring: string) => Promise<void>;
}

/** A `Logger` that records every call, for asserting on — and waiting for — emitted lines. */
function recordingLogger(): RecordingLogger {
  const lines: LogLine[] = [];
  const waiters: { substring: string; resolve: () => void }[] = [];
  const at =
    (level: LogLine["level"]) =>
    (msg: string, data?: Record<string, unknown>): void => {
      lines.push({ level, msg, data });
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (msg.includes(waiters[i]!.substring)) waiters.splice(i, 1)[0]!.resolve();
      }
    };
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
    emitted: (substring: string) =>
      lines.some((l) => l.msg.includes(substring))
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ substring, resolve });
          }),
  };
}

/**
 * The line the queue emits when it parks a failed job on its retry timer. It is
 * written on the same synchronous run as the `sleepingRetries` registration, so
 * seeing it is exactly "the sleeper exists and `shutdown()` can find it" — the
 * readiness these tests need before they call `shutdown()`.
 */
const RETRY_SCHEDULED = "job failed, retrying in";

/** Lines emitted by the abandon path, whatever the queue name. */
function abandonLines(lines: LogLine[]): LogLine[] {
  return lines.filter((l) => l.msg.includes("abandoned at shutdown"));
}

/** Resolve-able signal, so tests wait on an event instead of a fixed sleep. */
function signal(): { fired: Promise<void>; fire: () => void } {
  let fire: () => void = () => {};
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fired, fire };
}

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("LocalQueue.shutdown — retries inside the budget", () => {
  // CONTROL for the whole file: before the budget check existed, `shutdown()`
  // released every sleeper unconditionally and this job stopped after its first
  // attempt — `attempts` would be `[0]` and `succeeded` false.
  it("lets a job finish a retry chain that fits in the shutdown budget", async () => {
    const { logger, emitted } = recordingLogger();
    const q = new LocalQueue<{ v: string }>("test-shutdown", logger);

    const attempts: number[] = [];
    let succeeded = false;

    q.process(
      async (job: QueueJob<{ v: string }>) => {
        attempts.push(job.attemptsMade);
        if (job.attemptsMade < 2) throw new Error("transient");
        succeeded = true;
      },
      { backoffStrategy: () => 300 },
    );

    await q.add("job", { v: "x" }, { attempts: 5 });
    await emitted(RETRY_SCHEDULED); // the retry is parked; shutdown can see it

    const startedAt = Date.now();
    await q.shutdown();
    const elapsed = Date.now() - startedAt;

    expect(attempts).toEqual([0, 1, 2]);
    expect(succeeded).toBe(true);
    // Two 300ms backoffs, not the 10s cap: shutdown waited for the work, and
    // returned as soon as it settled.
    expect(elapsed).toBeLessThan(5_000);
    expect(await q.count()).toBe(0);
  });
});

describe("LocalQueue.shutdown — retries beyond the budget", () => {
  it("abandons a sleeper whose backoff cannot fit, and does not pin the loop", async () => {
    const { lines, logger, emitted } = recordingLogger();
    const q = new LocalQueue<{ v: string }>("slow-retry-queue", logger);

    const attempts: number[] = [];

    q.process(
      async (job: QueueJob<{ v: string }>) => {
        attempts.push(job.attemptsMade);
        throw new Error("transient");
      },
      // Far beyond the 10s shutdown grace period.
      { backoffStrategy: () => 60_000 },
    );

    const jobId = await q.add("job", { v: "x" }, { attempts: 5 });
    await emitted(RETRY_SCHEDULED);

    const startedAt = Date.now();
    await q.shutdown();
    const elapsed = Date.now() - startedAt;

    expect(attempts).toEqual([0]);
    // Released, not waited on: nowhere near the 10s cap.
    expect(elapsed).toBeLessThan(2_000);
    expect(await q.count()).toBe(0);

    // The drop is never silent: queue, job and attempt are all named.
    const abandoned = abandonLines(lines);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.level).toBe("warn");
    expect(abandoned[0]!.msg).toContain("slow-retry-queue");
    expect(abandoned[0]!.data?.queue).toBe("slow-retry-queue");
    expect(abandoned[0]!.data?.jobId).toBe(jobId);
    expect(abandoned[0]!.data?.attempt).toBe(1);
  });

  // The teardown a test wants from a process-global queue: no budget at all, so
  // every sleeper goes regardless of how soon it was due. This is what
  // `_resetLlmUsageRetryWorkerForTests` asks for.
  it("abandons every sleeper under a zero grace, and never runs the attempt", async () => {
    const { lines, logger, emitted } = recordingLogger();
    const q = new LocalQueue<{ v: string }>("test-shutdown", logger);

    const attempts: number[] = [];

    q.process(
      async (job: QueueJob<{ v: string }>) => {
        attempts.push(job.attemptsMade);
        throw new Error("transient");
      },
      // Comfortably inside the PRODUCTION budget — it survives a default
      // shutdown (the first test in this file). Only the explicit grace of 0
      // drops it.
      { backoffStrategy: () => 300 },
    );

    await q.add("job", { v: "x" }, { attempts: 5 });
    await emitted(RETRY_SCHEDULED);

    const startedAt = Date.now();
    await q.shutdown(0);
    // Released, not waited on — the same budget its two siblings assert. What
    // discriminates "did not wait for the 300ms backoff" is `attempts` and the
    // abandon line below, not the clock; this only pins that shutdown did not
    // sit on the 10s grace, and 2s says that without betting on a 200ms
    // scheduling window in a process running the whole suite.
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    expect(attempts).toEqual([0]);
    expect(abandonLines(lines)).toHaveLength(1);

    // The retry timer really was cleared, not merely orphaned: 600ms is well
    // past the 300ms it was armed for.
    await tick(600);
    expect(attempts).toEqual([0]);
    expect(await q.count()).toBe(0);
  });
});

describe("LocalQueue.shutdown — failures during shutdown", () => {
  it("does not arm a new timer when the retry falls outside the remaining budget", async () => {
    const { lines, logger, emitted } = recordingLogger();
    const q = new LocalQueue<{ v: string }>("test-shutdown", logger);

    const attempts: number[] = [];

    q.process(
      async (job: QueueJob<{ v: string }>) => {
        attempts.push(job.attemptsMade);
        throw new Error("transient");
      },
      // Attempt 2 is due inside the budget and runs DURING shutdown; the retry
      // it schedules is not, so it must be dropped rather than armed.
      { backoffStrategy: (attempt) => (attempt === 1 ? 200 : 60_000) },
    );

    await q.add("job", { v: "x" }, { attempts: 5 });
    await emitted(RETRY_SCHEDULED);

    const startedAt = Date.now();
    await q.shutdown();
    const elapsed = Date.now() - startedAt;

    // The in-budget retry ran, the out-of-budget one did not.
    expect(attempts).toEqual([0, 1]);
    expect(elapsed).toBeLessThan(2_000);
    expect(await q.count()).toBe(0);

    const abandoned = abandonLines(lines);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.data?.attempt).toBe(2);

    // Nothing is left armed: waiting past any plausible timer changes nothing.
    await tick(400);
    expect(attempts).toEqual([0, 1]);
  });
});

describe("LocalQueue.shutdown — jobs that never started", () => {
  /**
   * The sleeper rule above says a retry inside the budget is work that would
   * have completed. A job still sitting in `pending` is the same work, one step
   * earlier — and it was dropped without so much as a log line, because
   * `drain()` returns early once `shuttingDown` is set.
   */
  it("runs queued-but-unstarted jobs that fit in the budget", async () => {
    const { lines, logger } = recordingLogger();
    const queue = new LocalQueue<{ n: number }>("test-pending", logger);
    const ran: number[] = [];
    const started = signal();

    queue.process(
      async (job: QueueJob<{ n: number }>) => {
        ran.push(job.data.n);
        if (ran.length === 1) started.fire();
        await tick(20);
      },
      { concurrency: 1 },
    );

    // Four jobs, concurrency 1: the first runs, three queue behind it.
    for (const n of [1, 2, 3, 4]) await queue.add("job", { n });
    await started.fired;
    expect(await queue.count()).toBeGreaterThan(1);

    await queue.shutdown(2_000);

    expect(ran.sort()).toEqual([1, 2, 3, 4]);
    expect(abandonLines(lines)).toHaveLength(0);
  });

  /**
   * With no budget there is no time to run them, so they go — but loudly. A
   * silent drop is the failure this whole file exists to prevent, and it does
   * not stop mattering because the job had not started yet.
   */
  it("abandons queued jobs under a zero grace, and names each one", async () => {
    const { lines, logger } = recordingLogger();
    const queue = new LocalQueue<{ n: number }>("test-pending-zero", logger);
    const ran: number[] = [];
    const started = signal();

    queue.process(
      async (job: QueueJob<{ n: number }>) => {
        ran.push(job.data.n);
        if (ran.length === 1) started.fire();
        await tick(20);
      },
      { concurrency: 1 },
    );

    for (const n of [1, 2, 3]) await queue.add("job", { n });
    await started.fired;

    await queue.shutdown(0);

    // Only the in-flight job ran; the other two were abandoned, each logged.
    expect(ran).toEqual([1]);
    const abandoned = abandonLines(lines).filter((l) => l.msg.includes("never started"));
    expect(abandoned).toHaveLength(2);
    expect(abandoned[0]?.data).toMatchObject({ queue: "test-pending-zero", jobName: "job" });

    // And they stay abandoned: nothing re-drains them after shutdown returns.
    // (`count()` still reports the in-flight job — shutdown(0) does not wait
    // for it — so assert on what actually ran, not on the queue depth.)
    await tick(80);
    expect(ran).toEqual([1]);
  });
});
