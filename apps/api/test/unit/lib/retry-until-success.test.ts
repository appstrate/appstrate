// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../../src/lib/logger.ts";
import { retryUntilSuccess } from "../../../src/lib/retry-until-success.ts";

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
    await Bun.sleep(2);
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

describe("retryUntilSuccess", () => {
  it("returns after a successful first attempt without logging or retrying", async () => {
    const f = flaky(0);
    await retryUntilSuccess("Thing", f.attempt, opts());

    await Bun.sleep(20);
    expect(f.calls()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("logs the first failure with the first retry delay, then resolves", async () => {
    const f = flaky(1);
    await retryUntilSuccess("Thing", f.attempt, opts());

    expect(warn.mock.calls[0]).toEqual([
      "Thing failed — retrying in background",
      { error: "boom 1", retryInMs: 1 },
    ]);
  });

  it("retries until the attempt resolves, then logs recovery", async () => {
    const f = flaky(3);
    await retryUntilSuccess("Thing", f.attempt, opts());
    await waitFor(() => info.mock.calls.length > 0);

    expect(f.calls()).toBe(4);
    expect(warn.mock.calls.slice(1).map((c: unknown[]) => c[0])).toEqual([
      "Thing retry failed",
      "Thing retry failed",
    ]);
    expect(warn.mock.calls[1]?.[1]).toEqual({ error: "boom 2", attempt: 1, nextDelayMs: 2 });
    expect(info).toHaveBeenCalledWith("Thing recovered after retry", { attempts: 3 });
  });

  it("doubles the delay and caps it at maxDelayMs", async () => {
    const f = flaky(5);
    await retryUntilSuccess("Thing", f.attempt, opts());
    await waitFor(() => info.mock.calls.length > 0);

    const delays = warn.mock.calls
      .slice(1)
      .map((c: unknown[]) => (c[1] as { nextDelayMs: number }).nextDelayMs);
    expect(delays).toEqual([2, 4, 4, 4]);
  });

  it("logs failures at the requested level", async () => {
    const f = flaky(2);
    await retryUntilSuccess("Realtime LISTEN", f.attempt, { ...opts(), level: "error" });
    await waitFor(() => info.mock.calls.length > 0);

    expect(warn).not.toHaveBeenCalled();
    expect(error.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      "Realtime LISTEN failed — retrying in background",
      "Realtime LISTEN retry failed",
    ]);
  });

  it("stops attempting once the signal is aborted", async () => {
    const f = flaky(Number.POSITIVE_INFINITY);
    await retryUntilSuccess("Thing", f.attempt, opts());
    await waitFor(() => f.calls() >= 3);

    controller.abort();
    const callsAtAbort = f.calls();
    await Bun.sleep(30);
    expect(f.calls()).toBe(callsAtAbort);
    expect(info).not.toHaveBeenCalled();
  });

  it("catches a synchronous throw from the attempt, first and on retry", async () => {
    let calls = 0;
    const attempt = (): Promise<void> => {
      calls++;
      if (calls <= 2) throw new Error(`sync boom ${calls}`);
      return Promise.resolve();
    };
    await expect(retryUntilSuccess("Thing", attempt, opts())).resolves.toBeUndefined();
    await waitFor(() => info.mock.calls.length > 0);

    expect(warn.mock.calls[0]?.[1]).toMatchObject({ error: "sync boom 1" });
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ error: "sync boom 2", attempt: 1 });
    expect(info).toHaveBeenCalledWith("Thing recovered after retry", { attempts: 2 });
  });
});
