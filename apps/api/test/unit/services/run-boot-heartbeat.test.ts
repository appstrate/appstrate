// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the boot-phase liveness pump — the platform attesting, on
 * the runner's behalf, that a run it is still provisioning is alive.
 *
 * The pump's whole value depends on it being impossible to abuse: it must
 * keep a slow-but-healthy boot alive, and must NOT keep alive a run whose
 * workload died, whose liveness is unknown, or which blew its provisioning
 * ceiling. Every case below is one of those constraints.
 */

import { describe, it, expect } from "bun:test";
import { startBootHeartbeat } from "../../../src/services/run-boot-heartbeat.ts";
import type { BootHeartbeatOutcome } from "../../../src/services/state/runs.ts";

const TICK_MS = 5;

/** Wait until `predicate` holds or the budget expires (keeps tests fast). */
async function waitFor(predicate: () => boolean, budgetMs = 500): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
}

describe("boot heartbeat pump", () => {
  it("keeps bumping while the run is still provisioning", async () => {
    let calls = 0;
    const stop = startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      record: async () => {
        calls++;
        return "bumped";
      },
    });

    await waitFor(() => calls >= 3);
    stop();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("retires as soon as the runner reports for itself", async () => {
    let calls = 0;
    startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      record: async () => {
        calls++;
        return calls === 1 ? "bumped" : "guest-active";
      },
    });

    await waitFor(() => calls >= 2);
    const settled = calls;
    await Bun.sleep(TICK_MS * 6);
    // Real liveness has taken over — the pump must not keep writing.
    expect(calls).toBe(settled);
  });

  it("stops on a blown provisioning deadline instead of vouching forever", async () => {
    let calls = 0;
    startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      record: async () => {
        calls++;
        return "deadline-passed";
      },
    });

    await waitFor(() => calls >= 1);
    await Bun.sleep(TICK_MS * 6);
    // This is the anti-abuse constraint: a wedged provisioner must hand the
    // run over to the watchdog, not keep it artificially alive.
    expect(calls).toBe(1);
  });

  it("stops on a closed sink", async () => {
    let calls = 0;
    startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      record: async () => {
        calls++;
        return "closed";
      },
    });

    await waitFor(() => calls >= 1);
    await Bun.sleep(TICK_MS * 6);
    expect(calls).toBe(1);
  });

  it("never attests for a workload the backend reports dead", async () => {
    let calls = 0;
    startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      isAlive: async () => false,
      record: async () => {
        calls++;
        return "bumped";
      },
    });

    await Bun.sleep(TICK_MS * 6);
    expect(calls).toBe(0);
  });

  it("skips the beat when liveness is unknown, and resumes when it is known again", async () => {
    let probes = 0;
    let calls = 0;
    const stop = startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      // Unknown twice (daemon blip), then alive.
      isAlive: async () => (++probes <= 2 ? null : true),
      record: async () => {
        calls++;
        return "bumped";
      },
    });

    await waitFor(() => probes >= 2);
    // Degrade toward the watchdog: unknown is not "alive".
    expect(calls).toBe(0);

    await waitFor(() => calls >= 1);
    stop();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("treats a throwing liveness probe as unknown, not alive", async () => {
    let calls = 0;
    const stop = startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      isAlive: async () => {
        throw new Error("daemon unreachable");
      },
      record: async () => {
        calls++;
        return "bumped";
      },
    });

    await Bun.sleep(TICK_MS * 6);
    stop();
    expect(calls).toBe(0);
  });

  it("retries after a failed heartbeat write rather than giving up", async () => {
    let calls = 0;
    const stop = startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      record: async (): Promise<BootHeartbeatOutcome> => {
        calls++;
        if (calls === 1) throw new Error("db blip");
        return "bumped";
      },
    });

    await waitFor(() => calls >= 3);
    stop();
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("stops writing once stopped, and stopping twice is safe", async () => {
    let calls = 0;
    const stop = startBootHeartbeat({
      runId: "run_boot",
      intervalMs: TICK_MS,
      backend: "test",
      record: async () => {
        calls++;
        return "bumped";
      },
    });

    await waitFor(() => calls >= 1);
    stop();
    stop();
    const settled = calls;
    await Bun.sleep(TICK_MS * 6);
    expect(calls).toBe(settled);
  });
});
