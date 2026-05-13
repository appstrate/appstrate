// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the sidecar's `provider_call` concurrency limiter.
 *
 * The limiter exists to cap the number of in-flight upstream HTTP hops
 * a single run can issue at once. Without it, an agent fanning out N
 * parallel `provider_call`s can stuff the next LLM turn with hundreds
 * of KB of accumulated JSON and blow past the upstream model's TPM
 * window (issue #427). These tests pin the contract:
 *
 *   - capacity enforcement (≤ maxConcurrent simultaneous holders);
 *   - FIFO release order;
 *   - idempotent release;
 *   - env-var parsing fails loud on misconfiguration.
 */

import { describe, it, expect } from "bun:test";
import {
  DEFAULT_PROVIDER_CALL_CONCURRENCY,
  Semaphore,
  readPositiveConcurrencyEnv,
} from "../semaphore.ts";

describe("Semaphore", () => {
  it("rejects non-positive caps at construction time", () => {
    expect(() => new Semaphore(0)).toThrow(/positive integer/);
    expect(() => new Semaphore(-1)).toThrow(/positive integer/);
    expect(() => new Semaphore(1.5)).toThrow(/positive integer/);
    expect(() => new Semaphore(Number.POSITIVE_INFINITY)).toThrow(/positive integer/);
  });

  it("admits up to maxConcurrent permits immediately", async () => {
    const sem = new Semaphore(3);
    const a = await sem.acquire();
    const b = await sem.acquire();
    const c = await sem.acquire();
    expect(sem.inFlight).toBe(3);
    expect(sem.queued).toBe(0);
    a();
    b();
    c();
  });

  it("parks the 4th acquirer until a permit is released", async () => {
    const sem = new Semaphore(3);
    const a = await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    expect(sem.inFlight).toBe(3);

    let pendingResolved = false;
    const pending = sem.acquire().then((release) => {
      pendingResolved = true;
      return release;
    });

    // Yield twice to give the pending promise a chance to settle. If
    // the queue were broken, this would slip through.
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingResolved).toBe(false);
    expect(sem.queued).toBe(1);

    a();
    const release4 = await pending;
    expect(pendingResolved).toBe(true);
    expect(sem.inFlight).toBe(3);
    release4();
  });

  it("releases waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    const order: number[] = [];
    const w1 = sem.acquire().then((r) => {
      order.push(1);
      return r;
    });
    const w2 = sem.acquire().then((r) => {
      order.push(2);
      return r;
    });
    const w3 = sem.acquire().then((r) => {
      order.push(3);
      return r;
    });

    release1();
    const r1 = await w1;
    r1();
    const r2 = await w2;
    r2();
    const r3 = await w3;
    r3();
    expect(order).toEqual([1, 2, 3]);
  });

  it("release is idempotent — double-call doesn't refund two permits", async () => {
    const sem = new Semaphore(1);
    const r = await sem.acquire();
    r();
    r(); // second call must be a no-op

    // If the second call leaked a permit, this would be 0 after acquire.
    const r2 = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    r2();
  });
});

describe("readPositiveConcurrencyEnv", () => {
  const ENV = "SIDECAR_PROVIDER_CALL_CONCURRENCY_TEST";

  it("returns default when env var is unset", () => {
    delete process.env[ENV];
    expect(readPositiveConcurrencyEnv(ENV, 7)).toBe(7);
  });

  it("returns default when env var is empty", () => {
    process.env[ENV] = "";
    expect(readPositiveConcurrencyEnv(ENV, 9)).toBe(9);
    delete process.env[ENV];
  });

  it("parses a positive integer override", () => {
    process.env[ENV] = "12";
    expect(readPositiveConcurrencyEnv(ENV, 1)).toBe(12);
    delete process.env[ENV];
  });

  it("fails loud on zero / negative / non-integer / non-numeric input", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "NaN"]) {
      process.env[ENV] = bad;
      expect(() => readPositiveConcurrencyEnv(ENV, 1)).toThrow(/positive integer/);
    }
    delete process.env[ENV];
  });

  it("DEFAULT_PROVIDER_CALL_CONCURRENCY is a sane positive integer", () => {
    expect(Number.isInteger(DEFAULT_PROVIDER_CALL_CONCURRENCY)).toBe(true);
    expect(DEFAULT_PROVIDER_CALL_CONCURRENCY).toBeGreaterThan(0);
    // Three is a reasonable browse-bandwidth cap; pin the order of
    // magnitude so a future tweak doesn't accidentally remove the cap.
    expect(DEFAULT_PROVIDER_CALL_CONCURRENCY).toBeLessThanOrEqual(10);
  });
});
