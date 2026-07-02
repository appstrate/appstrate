// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the FirecrackerOrchestrator's host-side state machine —
 * everything that does NOT need KVM: the fail-closed initialization gate,
 * TAP/subnet rollback and index accounting, the orphan sweep's PID-reuse
 * guard, and shutdown teardown ordering. The boot path itself (config
 * drive, guest firewall, exit-marker round-trip) is covered by the smoke
 * harness on a real KVM host (scripts/firecracker-dev/smoke.ts).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetCacheForTesting } from "@appstrate/env";
import { FirecrackerOrchestrator } from "../../../../src/services/orchestrator/firecracker/firecracker-orchestrator.ts";
import type { HostExec } from "../../../../src/services/orchestrator/firecracker/host-net.ts";

interface RecordedCall {
  cmd: string[];
  stdin?: string;
}

function fakeExec(respond: (cmd: string[]) => string | Error = defaultRespond): {
  exec: HostExec;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    exec: {
      async run(cmd, opts) {
        calls.push({ cmd, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
        const result = respond(cmd);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

/** All host commands succeed; `ip -j link show` reports no TAP devices. */
function defaultRespond(cmd: string[]): string {
  return cmd.join(" ") === "ip -j link show" ? "[]" : "";
}

const ORIGINAL_DATA_DIR = process.env.FIRECRACKER_DATA_DIR;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "fc-orch-test-"));
  process.env.FIRECRACKER_DATA_DIR = dataDir;
  _resetCacheForTesting();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.FIRECRACKER_DATA_DIR;
  else process.env.FIRECRACKER_DATA_DIR = ORIGINAL_DATA_DIR;
  _resetCacheForTesting();
});

/**
 * The initialization gate is what the fail-closed tests below bypass: a
 * real initialize() needs Linux + KVM + built artifacts. Everything past
 * the gate is host-command driven and fully faked.
 */
function readyOrchestrator(exec: HostExec): FirecrackerOrchestrator {
  const orch = new FirecrackerOrchestrator({ hostExec: exec });
  Reflect.set(orch, "initialized", true);
  return orch;
}

/**
 * The allocator is round-robin (a released index is only re-drawn after a
 * full wrap), so "which index does the next run get" cannot observe a
 * release. The reserved-set is the actual accounting — read it directly.
 */
function reservedIndexes(orch: FirecrackerOrchestrator): Set<number> {
  const allocator = Reflect.get(orch, "allocator") as object;
  return Reflect.get(allocator, "inUse") as Set<number>;
}

describe("fail-closed initialization gate", () => {
  it("refuses to create a boundary when initialize() never succeeded", async () => {
    const { exec } = fakeExec();
    const orch = new FirecrackerOrchestrator({ hostExec: exec });
    // Boot's parallel init swallows initialize() errors — the run-time
    // gate is what actually keeps VMs from starting without the host
    // firewall.
    await expect(orch.createIsolationBoundary("run_1")).rejects.toThrow(/not initialized/);
  });
});

describe("createIsolationBoundary rollback", () => {
  it("releases the subnet index and removes the run dir when TAP creation fails", async () => {
    let failTap = true;
    const { exec } = fakeExec((cmd) => {
      if (failTap && cmd.join(" ").startsWith("ip tuntap add")) return new Error("tap boom");
      return defaultRespond(cmd);
    });
    const orch = readyOrchestrator(exec);

    await expect(orch.createIsolationBoundary("run_1")).rejects.toThrow("tap boom");

    // The failed attempt must not leak its index or its run dir.
    expect(reservedIndexes(orch).size).toBe(0);
    expect(await Bun.file(join(dataDir, "run_1", "state.json")).exists()).toBe(false);

    // And the orchestrator still works afterwards.
    failTap = false;
    const boundary = await orch.createIsolationBoundary("run_2");
    expect(boundary.name).toBe("firecracker-run_2");
    expect(reservedIndexes(orch).size).toBe(1);
  });
});

describe("TAP index accounting on teardown", () => {
  it("keeps the index reserved when the TAP delete fails (poisoned device)", async () => {
    let failDelete = true;
    const { exec } = fakeExec((cmd) => {
      if (failDelete && cmd.join(" ").startsWith("ip link del")) return new Error("busy");
      return defaultRespond(cmd);
    });
    const orch = readyOrchestrator(exec);

    const b1 = await orch.createIsolationBoundary("run_1");
    await orch.removeIsolationBoundary(b1);

    // afc1 still exists on the host — its index must stay reserved so no
    // future run collides with the lingering device.
    expect(reservedIndexes(orch).has(1)).toBe(true);
    failDelete = false;
  });

  it("releases the index after a successful delete", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);

    const b1 = await orch.createIsolationBoundary("run_1");
    expect(reservedIndexes(orch).has(1)).toBe(true);
    await orch.removeIsolationBoundary(b1);
    expect(reservedIndexes(orch).size).toBe(0);
  });
});

describe("cleanupOrphans PID-reuse guard", () => {
  it("does not kill a recorded pid that is not this run's firecracker VMM", async () => {
    // This test process's own pid is alive but is a bun process, not a
    // firecracker VMM — the identity check must refuse to kill it. (On
    // hosts without /proc the check also refuses: fail-closed.)
    const runDir = join(dataDir, "run_stale");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        runId: "run_stale",
        tapDevice: "afc7",
        pid: process.pid,
        apiSocketPath: "/tmp/afc-nonexistent.sock",
      }),
    );

    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);
    const report = await orch.cleanupOrphans();

    expect(report.workloads).toBe(0); // no kill issued
    expect(report.isolationBoundaries).toBe(1); // dir still reclaimed
    // The TAP device is still reclaimed regardless of the pid decision.
    expect(calls.map((c) => c.cmd.join(" "))).toContain("ip link del afc7");
    expect(await Bun.file(join(runDir, "state.json")).exists()).toBe(false);
  });

  it("skips dead pids without counting them as reclaimed workloads", async () => {
    const runDir = join(dataDir, "run_dead");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({ runId: "run_dead", tapDevice: "afc8", pid: 999_999_999 }),
    );

    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const report = await orch.cleanupOrphans();
    expect(report.workloads).toBe(0);
    expect(report.isolationBoundaries).toBe(1);
  });
});

describe("shutdown", () => {
  it("tears down per-run resources BEFORE removing the host firewall", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_1");

    await orch.shutdown();

    const joined = calls.map((c) => c.cmd.join(" "));
    const tapDelete = joined.indexOf("ip link del afc1");
    const nftDestroy = joined.indexOf("nft destroy table ip appstrate_fc");
    expect(tapDelete).toBeGreaterThan(-1);
    expect(nftDestroy).toBeGreaterThan(tapDelete);
    // The iptables FORWARD accepts are removed too (probe then delete).
    expect(joined).toContain("iptables -C FORWARD -i afc+ -j ACCEPT");
    // The run dir is gone.
    expect(await Bun.file(join(dataDir, "run_1", "state.json")).exists()).toBe(false);
  });
});

describe("waitForExit without a booted VM", () => {
  it("reports a non-clean exit for an unknown run", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    expect(await orch.waitForExit({ id: "x", runId: "nope", role: "agent" })).toBe(1);
  });
});
