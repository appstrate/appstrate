// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { createGate } from "../../../src/lib/gate.ts";

describe("createGate", () => {
  const options = { limit: 2, maxWaiting: 4, waitMs: 1_000, holdMs: 1_000 };

  it("never runs more than the limit at once, and runs everything", async () => {
    const run = createGate(options);
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          done.push(i);
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(done.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("frees its slot when the work throws", async () => {
    const run = createGate({ ...options, limit: 1 });
    await expect(
      run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await run(async () => "next")).toBe("next");
  });

  it("abandons work that hangs: its signal aborts, its slot goes to the next caller", async () => {
    const run = createGate({ ...options, limit: 1, holdMs: 30 });
    let signal: AbortSignal | undefined;
    const hung = run((s) => {
      signal = s;
      return new Promise<never>(() => {});
    });
    await expect(hung).rejects.toMatchObject({ reason: "hold_timeout" });
    expect(signal?.aborted).toBe(true);
    expect(await run(async () => "next")).toBe("next");
  });

  it("refuses a caller that waits too long, and one that finds the queue full", async () => {
    const run = createGate({ limit: 1, maxWaiting: 1, waitMs: 30, holdMs: 1_000 });
    const hold = run(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    const waiter = run(async () => "late");
    await expect(run(async () => "overflow")).rejects.toMatchObject({ reason: "queue_full" });
    await expect(waiter).rejects.toMatchObject({ reason: "wait_timeout" });
    await hold;
    expect(await run(async () => "after")).toBe("after");
  });
});
