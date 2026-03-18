import { describe, test, expect, mock, beforeEach } from "bun:test";

// --- Mocks ---

const noop = () => {};
const publishCalls: string[] = [];

mock.module("../../lib/logger.ts", () => ({
  logger: { debug: noop, info: noop, warn: noop, error: noop },
}));

// Use the same mock shape as other test files to avoid process-global conflicts.
// Must export ALL redis functions since mock.module is process-global in bun:test.
mock.module("../../lib/redis.ts", () => ({
  getRedisConnection: () => ({}),
  getRedisPublisher: () => ({
    publish: (_channel: string, message: string) => {
      publishCalls.push(message);
      return Promise.resolve(1);
    },
  }),
  getRedisSubscriber: () => ({
    subscribe: (_channel: string, cb: (err: Error | null) => void) => {
      cb(null);
    },
    unsubscribe: () => Promise.resolve(),
    on: () => {},
  }),
}));

const mod = await import("../execution-tracker.ts");

// bun:test's mock.module is process-global: if another test file (e.g. execution-retry.test.ts)
// mocks this entire module first, we get stubs instead of the real implementation.
// Detect this: the real module increments getInFlightCount() after trackExecution().
const isRealModule = (() => {
  try {
    const before = mod.getInFlightCount();
    mod.trackExecution("__probe__");
    const after = mod.getInFlightCount();
    mod.untrackExecution("__probe__");
    return after === before + 1;
  } catch {
    return false;
  }
})();

const { trackExecution, untrackExecution, abortExecution, getInFlightCount, waitForInFlight } = mod;

describe("execution-tracker", () => {
  beforeEach(() => {
    publishCalls.length = 0;
  });

  describe("trackExecution / untrackExecution", () => {
    test.skipIf(!isRealModule)("tracks and untracks executions", () => {
      const initialCount = getInFlightCount();
      const controller = trackExecution("et-1");
      expect(controller).toBeInstanceOf(AbortController);
      expect(getInFlightCount()).toBe(initialCount + 1);

      untrackExecution("et-1");
      expect(getInFlightCount()).toBe(initialCount);
    });

    test.skipIf(!isRealModule)("tracks multiple executions independently", () => {
      const initialCount = getInFlightCount();
      trackExecution("et-a");
      trackExecution("et-b");
      expect(getInFlightCount()).toBe(initialCount + 2);

      untrackExecution("et-a");
      expect(getInFlightCount()).toBe(initialCount + 1);

      untrackExecution("et-b");
      expect(getInFlightCount()).toBe(initialCount);
    });

    test.skipIf(!isRealModule)("untrack is idempotent for unknown ids", () => {
      const before = getInFlightCount();
      untrackExecution("nonexistent");
      expect(getInFlightCount()).toBe(before);
    });
  });

  describe("abortExecution", () => {
    test.skipIf(!isRealModule)("aborts local controller", () => {
      const controller = trackExecution("et-abort-1");
      expect(controller.signal.aborted).toBe(false);

      abortExecution("et-abort-1");
      expect(controller.signal.aborted).toBe(true);

      untrackExecution("et-abort-1");
    });

    test.skipIf(!isRealModule)("publishes cancel signal to Redis", async () => {
      trackExecution("et-abort-2");
      abortExecution("et-abort-2");

      await new Promise((r) => setTimeout(r, 50));
      expect(publishCalls).toContain("et-abort-2");

      untrackExecution("et-abort-2");
    });

    test.skipIf(!isRealModule)("publishes even when execution is not local", async () => {
      abortExecution("et-remote-exec");

      await new Promise((r) => setTimeout(r, 50));
      expect(publishCalls).toContain("et-remote-exec");
    });
  });

  describe("waitForInFlight", () => {
    test.skipIf(!isRealModule)("returns true when executions drain before timeout", async () => {
      trackExecution("et-draining");
      setTimeout(() => untrackExecution("et-draining"), 50);
      const result = await waitForInFlight(2000);
      expect(result).toBe(true);
    });
  });
});
