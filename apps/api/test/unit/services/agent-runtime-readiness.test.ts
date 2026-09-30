// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for agent-runtime readiness: the flag tracks a successful orchestrator
 * `initialize()` (#1129). Retry mechanics are covered by the retry helper's suite.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { logger } from "../../../src/lib/logger.ts";
import {
  _resetAgentRuntimeReadinessForTesting,
  initializeAgentRuntime,
  isAgentRuntimeReady,
} from "../../../src/services/orchestrator/agent-runtime-readiness.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(2);
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

  it("becomes ready once initialize() succeeds", async () => {
    const orchestrator = flakyOrchestrator(1);

    await initializeAgentRuntime(orchestrator, fast);
    expect(isAgentRuntimeReady()).toBe(false);

    await waitFor(isAgentRuntimeReady);
    expect(orchestrator.calls).toBe(2);
  });

  it("stays not ready while initialize() keeps failing (fail-closed)", async () => {
    const orchestrator = flakyOrchestrator(Infinity);

    await initializeAgentRuntime(orchestrator, fast);
    await waitFor(() => orchestrator.calls >= 4);

    expect(isAgentRuntimeReady()).toBe(false);
  });
});
