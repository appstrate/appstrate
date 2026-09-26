// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for agent-runtime readiness — the background retry that lets
 * `/health` recover from a transient orchestrator `initialize()` failure at
 * boot (#1129) instead of reporting `agents: degraded` until a restart,
 * while a backend that stays broken stays degraded.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../../src/lib/logger.ts";
import {
  _resetAgentRuntimeReadinessForTesting,
  initializeAgentRuntime,
  isAgentRuntimeReady,
  stopAgentRuntimeRecovery,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";

const FAST = { initialDelayMs: 1, maxDelayMs: 4 };

/** Wait until `predicate` holds or the budget expires (keeps tests fast). */
async function waitFor(predicate: () => boolean, budgetMs = 500): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
}

/** Fake orchestrator whose `initialize()` fails its first `failures` calls. */
function flakyOrchestrator(failures: number) {
  const fake = {
    calls: 0,
    initialize: async (): Promise<void> => {
      fake.calls++;
      if (fake.calls <= failures) throw new Error("docker daemon unreachable");
    },
  };
  return fake;
}

/** Fake orchestrator whose single `initialize()` call stays pending until settled by the test. */
function pendingOrchestrator() {
  const pending = Promise.withResolvers<void>();
  const fake = {
    calls: 0,
    pending,
    initialize: (): Promise<void> => {
      fake.calls++;
      return pending.promise;
    },
  };
  return fake;
}

describe("agent runtime readiness", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let info: ReturnType<typeof spyOn<typeof logger, "info">>;

  beforeEach(() => {
    _resetAgentRuntimeReadinessForTesting();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    // Retire any pending retry, or a leaked timer keeps firing into the next test.
    _resetAgentRuntimeReadinessForTesting();
    warn.mockRestore();
    info.mockRestore();
  });

  it("is ready after a successful first attempt and never retries", async () => {
    const orchestrator = flakyOrchestrator(0);

    await initializeAgentRuntime(orchestrator, FAST);

    expect(isAgentRuntimeReady()).toBe(true);
    await Bun.sleep(20);
    expect(orchestrator.calls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("recovers from a failed boot attempt without a restart (#1129)", async () => {
    const orchestrator = flakyOrchestrator(1);

    await initializeAgentRuntime(orchestrator, FAST);
    expect(isAgentRuntimeReady()).toBe(false);

    await waitFor(isAgentRuntimeReady);
    expect(isAgentRuntimeReady()).toBe(true);
    expect(orchestrator.calls).toBe(2);
    expect(info).toHaveBeenCalledWith("Container orchestrator recovered", { attempts: 2 });

    // Recovered: no further attempts.
    await Bun.sleep(20);
    expect(orchestrator.calls).toBe(2);
  });

  it("stays not ready while the backend keeps failing (fail-closed)", async () => {
    const orchestrator = flakyOrchestrator(Infinity);

    await initializeAgentRuntime(orchestrator, FAST);
    await waitFor(() => orchestrator.calls >= 4);

    expect(orchestrator.calls).toBeGreaterThanOrEqual(4);
    expect(isAgentRuntimeReady()).toBe(false);
  });

  it("doubles the retry delay up to the ceiling", async () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout");
    try {
      const orchestrator = flakyOrchestrator(Infinity);

      await initializeAgentRuntime(orchestrator, FAST);
      await waitFor(() => orchestrator.calls >= 6);

      const delays = setTimeoutSpy.mock.calls.map((call) => call[1]).slice(0, 5);
      expect(delays).toEqual([1, 2, 4, 4, 4]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("cancels a pending retry on stop", async () => {
    const orchestrator = flakyOrchestrator(Infinity);

    await initializeAgentRuntime(orchestrator, { initialDelayMs: 20, maxDelayMs: 20 });
    stopAgentRuntimeRecovery();

    await Bun.sleep(60);
    expect(orchestrator.calls).toBe(1);
  });

  it("does not wait for an in-flight attempt, and schedules no retry when it fails after stop", async () => {
    // A Docker attempt can be a long cold pull: shutdown must not block on it.
    const orchestrator = pendingOrchestrator();
    const init = initializeAgentRuntime(orchestrator, FAST);

    stopAgentRuntimeRecovery(); // synchronous: returns while the attempt is still pending

    orchestrator.pending.reject(new Error("still down"));
    await init;
    await Bun.sleep(20);
    expect(orchestrator.calls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ignores an in-flight attempt that succeeds after stop", async () => {
    const orchestrator = pendingOrchestrator();
    const init = initializeAgentRuntime(orchestrator, FAST);

    stopAgentRuntimeRecovery();
    orchestrator.pending.resolve();
    await init;

    expect(isAgentRuntimeReady()).toBe(false);
  });

  it("retires the previous retry chain when called again", async () => {
    const first = flakyOrchestrator(Infinity);
    await initializeAgentRuntime(first, FAST);
    await waitFor(() => first.calls >= 2);

    const second = flakyOrchestrator(0);
    await initializeAgentRuntime(second, FAST);
    const retired = first.calls;

    await Bun.sleep(20);
    expect(first.calls).toBe(retired);
    expect(isAgentRuntimeReady()).toBe(true);
  });

  it("never rejects, whether initialize() throws synchronously or rejects", async () => {
    await expect(
      initializeAgentRuntime(
        {
          initialize: () => {
            throw new Error("sync failure");
          },
        },
        FAST,
      ),
    ).resolves.toBeUndefined();
    _resetAgentRuntimeReadinessForTesting();

    await expect(
      initializeAgentRuntime({ initialize: () => Promise.reject(new Error("async")) }, FAST),
    ).resolves.toBeUndefined();
    expect(isAgentRuntimeReady()).toBe(false);
  });
});
