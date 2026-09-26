// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for agent-runtime readiness — a transient orchestrator
 * `initialize()` failure at boot recovers in the background (#1129) instead of
 * pinning `agents: degraded` until a restart, while a backend that stays
 * broken stays degraded. Backoff itself is covered by the retry helper's suite.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../../src/lib/logger.ts";
import {
  _resetAgentRuntimeReadinessForTesting,
  initializeAgentRuntime,
  isAgentRuntimeReady,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";

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

describe("agent runtime readiness", () => {
  let controller: AbortController;
  let fast: { initialDelayMs: number; maxDelayMs: number; signal: AbortSignal };
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let info: ReturnType<typeof spyOn<typeof logger, "info">>;

  beforeEach(() => {
    _resetAgentRuntimeReadinessForTesting();
    controller = new AbortController();
    fast = { initialDelayMs: 1, maxDelayMs: 4, signal: controller.signal };
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    // No retry loop may outlive its test.
    controller.abort();
    _resetAgentRuntimeReadinessForTesting();
    warn.mockRestore();
    info.mockRestore();
  });

  it("is ready after a successful first attempt and never retries", async () => {
    const orchestrator = flakyOrchestrator(0);

    await initializeAgentRuntime(orchestrator, fast);

    expect(isAgentRuntimeReady()).toBe(true);
    await Bun.sleep(20);
    expect(orchestrator.calls).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("recovers from a failed boot attempt without a restart (#1129)", async () => {
    const orchestrator = flakyOrchestrator(1);

    await initializeAgentRuntime(orchestrator, fast);
    expect(isAgentRuntimeReady()).toBe(false);
    expect(warn.mock.calls[0]?.[0]).toStartWith("Could not initialize container orchestrator");

    await waitFor(isAgentRuntimeReady);
    expect(isAgentRuntimeReady()).toBe(true);
    expect(orchestrator.calls).toBe(2);

    // Recovered: no further attempts.
    await Bun.sleep(20);
    expect(orchestrator.calls).toBe(2);
  });

  it("stays not ready while the backend keeps failing (fail-closed)", async () => {
    const orchestrator = flakyOrchestrator(Infinity);

    await initializeAgentRuntime(orchestrator, fast);
    await waitFor(() => orchestrator.calls >= 4);

    expect(orchestrator.calls).toBeGreaterThanOrEqual(4);
    expect(isAgentRuntimeReady()).toBe(false);
  });

  it("never rejects, whether initialize() throws synchronously or rejects", async () => {
    await expect(
      initializeAgentRuntime(
        {
          initialize: () => {
            throw new Error("sync failure");
          },
        },
        fast,
      ),
    ).resolves.toBeUndefined();

    await expect(
      initializeAgentRuntime({ initialize: () => Promise.reject(new Error("async")) }, fast),
    ).resolves.toBeUndefined();
    expect(isAgentRuntimeReady()).toBe(false);
  });
});
