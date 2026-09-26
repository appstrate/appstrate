// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../../src/lib/logger.ts";
import { retryInBackground } from "../../../src/lib/retry-in-background.ts";

type Spy = ReturnType<typeof spyOn>;
let warn: Spy;
let error: Spy;
let info: Spy;
let controller: AbortController;

beforeEach(() => {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
  error = spyOn(logger, "error").mockImplementation(() => {});
  info = spyOn(logger, "info").mockImplementation(() => {});
  controller = new AbortController();
});

afterEach(() => {
  controller.abort();
  warn.mockRestore();
  error.mockRestore();
  info.mockRestore();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Fails `failures` times, then resolves. */
function flaky(failures: number): { attempt: () => Promise<void>; calls: () => number } {
  let calls = 0;
  return {
    attempt: async () => {
      calls++;
      if (calls <= failures) throw new Error(`boom ${calls}`);
    },
    calls: () => calls,
  };
}

const opts = () => ({ initialDelayMs: 1, maxDelayMs: 4, signal: controller.signal });

describe("retryInBackground", () => {
  it("retries until the attempt resolves, then logs recovery", async () => {
    const f = flaky(3);
    retryInBackground("Thing", f.attempt, opts());
    await waitFor(() => info.mock.calls.length > 0);

    expect(f.calls()).toBe(4);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]).toEqual([
      "Thing retry failed",
      { error: "boom 1", attempt: 1, nextDelayMs: 2 },
    ]);
    expect(info).toHaveBeenCalledWith("Thing recovered after retry", { attempts: 4 });
  });

  it("doubles the delay and caps it at maxDelayMs", async () => {
    const f = flaky(4);
    retryInBackground("Thing", f.attempt, opts());
    await waitFor(() => info.mock.calls.length > 0);

    const delays = warn.mock.calls.map(
      (c: unknown[]) => (c[1] as { nextDelayMs: number }).nextDelayMs,
    );
    expect(delays).toEqual([2, 4, 4, 4]);
  });

  it("logs failed retries at the requested level", async () => {
    const f = flaky(2);
    retryInBackground("Realtime LISTEN", f.attempt, { ...opts(), level: "error" });
    await waitFor(() => info.mock.calls.length > 0);

    expect(warn).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]?.[0]).toBe("Realtime LISTEN retry failed");
  });

  it("stops attempting once the signal is aborted", async () => {
    const f = flaky(Number.POSITIVE_INFINITY);
    retryInBackground("Thing", f.attempt, opts());
    await waitFor(() => f.calls() >= 2);

    controller.abort();
    const callsAtAbort = f.calls();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls()).toBe(callsAtAbort);
    expect(info).not.toHaveBeenCalled();
  });

  it("catches a synchronous throw from the attempt", async () => {
    let calls = 0;
    const attempt = (): Promise<void> => {
      calls++;
      if (calls === 1) throw new Error("sync boom");
      return Promise.resolve();
    };
    retryInBackground("Thing", attempt, opts());
    await waitFor(() => info.mock.calls.length > 0);

    expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: "sync boom", attempt: 1 });
    expect(info).toHaveBeenCalledWith("Thing recovered after retry", { attempts: 2 });
  });
});
