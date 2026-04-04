// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { LocalQueue } from "../../src/infra/queue/local-queue.ts";
import { PermanentJobError } from "../../src/infra/queue/interface.ts";

let queue: LocalQueue<{ value: string }>;

afterEach(async () => {
  await queue?.shutdown();
});

describe("LocalQueue", () => {
  it("processes added jobs", async () => {
    queue = new LocalQueue("test");
    const processed: string[] = [];

    queue.process(async (job) => {
      processed.push(job.data.value);
    });

    await queue.add("job1", { value: "a" });
    await queue.add("job2", { value: "b" });

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    expect(processed).toEqual(["a", "b"]);
  });

  it("returns a job ID from add", async () => {
    queue = new LocalQueue("test");
    queue.process(async () => {});

    const id = await queue.add("j", { value: "x" });
    expect(id).toBeString();
    expect(id.startsWith("local_")).toBe(true);
  });

  it("respects concurrency limit", async () => {
    queue = new LocalQueue("test");
    let concurrent = 0;
    let maxConcurrent = 0;

    queue.process(
      async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 50));
        concurrent--;
      },
      { concurrency: 2 },
    );

    await queue.add("j1", { value: "a" });
    await queue.add("j2", { value: "b" });
    await queue.add("j3", { value: "c" });
    await queue.add("j4", { value: "d" });

    await new Promise((r) => setTimeout(r, 300));

    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  it("retries failed jobs with backoff", async () => {
    queue = new LocalQueue("test");
    let attempts = 0;

    queue.process(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient failure");
      },
      { concurrency: 1 },
    );

    await queue.add("retry-job", { value: "x" }, { attempts: 3 });

    // Wait for retries (attempt 1 immediate, retry at ~1s, retry at ~2s)
    await new Promise((r) => setTimeout(r, 4000));

    expect(attempts).toBe(3);
  }, 10000);

  it("does not retry PermanentJobError", async () => {
    queue = new LocalQueue("test");
    let attempts = 0;

    queue.process(async () => {
      attempts++;
      throw new PermanentJobError("permanent failure");
    });

    await queue.add("perm-fail", { value: "x" }, { attempts: 5 });

    await new Promise((r) => setTimeout(r, 200));

    expect(attempts).toBe(1);
  });

  it("does not retry beyond max attempts", async () => {
    queue = new LocalQueue("test");
    let attempts = 0;

    queue.process(async () => {
      attempts++;
      throw new Error("always fails");
    });

    await queue.add("fail-job", { value: "x" }, { attempts: 2 });

    await new Promise((r) => setTimeout(r, 3000));

    expect(attempts).toBe(2);
  }, 10000);

  it("upsertScheduler and removeScheduler do not throw", async () => {
    queue = new LocalQueue("test");
    queue.process(async () => {});

    await queue.upsertScheduler(
      "sched-1",
      { pattern: "0 * * * *", tz: "UTC" },
      { name: "cron-job", data: { value: "scheduled" } },
    );

    await queue.removeScheduler("sched-1");
    // No assertion — just verifying no error thrown
  });

  it("shutdown waits for active jobs", async () => {
    queue = new LocalQueue("test");
    let completed = false;

    queue.process(async () => {
      await new Promise((r) => setTimeout(r, 100));
      completed = true;
    });

    await queue.add("slow-job", { value: "x" });
    await new Promise((r) => setTimeout(r, 10)); // let it start
    await queue.shutdown();

    expect(completed).toBe(true);
  });
});
