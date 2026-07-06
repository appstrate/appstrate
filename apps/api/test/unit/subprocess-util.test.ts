// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for spawnCollect, the shared subprocess collector behind the
 * process/firecracker orchestrators and the firecracker host-net executor.
 * Covers the normal collect path and the timeoutMs guard (B3): a wedged
 * privileged host op must be SIGKILLed and reported loudly instead of
 * hanging destroyVm/shutdown forever.
 */

import { describe, it, expect } from "bun:test";
import { spawnCollect } from "../../src/services/orchestrator/subprocess-util.ts";

describe("spawnCollect", () => {
  it("collects exitCode and stdout from a normal command", async () => {
    const result = await spawnCollect(["echo", "hi"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
    expect(result.stderr).toBe("");
  });

  it("kills and rejects when timeoutMs elapses before exit", async () => {
    const started = Date.now();
    let thrown: unknown;
    try {
      await spawnCollect(["sleep", "5"], { timeoutMs: 150 });
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - started;
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("timed out");
    expect((thrown as Error).message).toContain("sleep 5");
    expect(elapsed).toBeLessThan(2000); // rejected on the timer, not the 5s sleep
  });

  it("resolves normally when the command exits before timeoutMs", async () => {
    const result = await spawnCollect(["sleep", "0.05"], { timeoutMs: 5000 });
    expect(result.exitCode).toBe(0);
  });
});
