// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the FirecrackerOrchestrator's host-side state machine —
 * everything that does NOT need KVM: the fail-closed initialization gate,
 * TAP/subnet rollback and index accounting, the orphan sweep's PID-reuse
 * guard, and shutdown teardown ordering. The boot path itself (config
 * drive, guest firewall, exit-marker round-trip) is covered by the smoke
 * harness on a real KVM host (scripts/firecracker-dev/smoke.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetFirecrackerEnvCacheForTesting as _resetCacheForTesting } from "../../runner/host-env.ts";
import { FirecrackerOrchestrator, type FirecrackerOrchestratorDeps } from "../../orchestrator.ts";
import { deriveJailId, jailChrootBase } from "../../jail.ts";
import { workloadSpecSchema } from "../../runner/protocol.ts";
import { fakeHostExec as fakeExec, defaultRespond } from "../helpers/fake-host-exec.ts";
import {
  installFirecrackerDataDir,
  readyOrchestrator,
  reservedIndexes,
  vmsOf as vmsOfInternal,
} from "../helpers/orchestrator-fixture.ts";

/** The VmRecord fields these tests assert on (private map, read via Reflect). */
interface VmRecordView {
  stopping: boolean;
  teardownReason?: string;
  exitedAt?: number;
  requirements?: {
    capabilities: readonly unknown[];
    supplementalResources: { memoryBytes: number; nanoCpus: number; pidsLimit?: number };
  };
}

/** Typed view over the shared Reflect accessor for this file's assertions. */
function vmsOf(orch: FirecrackerOrchestrator): Map<string, VmRecordView> {
  return vmsOfInternal<VmRecordView>(orch);
}

let dataDir: string;
installFirecrackerDataDir("fc-orch-test-", (d) => {
  dataDir = d;
});

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
      // TAP creation is a single `ip -batch -` run fed via stdin.
      if (failTap && cmd.join(" ") === "ip -batch -") return new Error("tap boom");
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

describe("browser capability admission", () => {
  const oneBrowser = {
    capabilities: [{ kind: "browser" as const, profile: "standard" as const, instances: 1 }],
    supplementalResources: {
      memoryBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
    },
  };

  it("persists admitted requirements until VM boot", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_browser", { requirements: oneBrowser });
    expect(vmsOf(orch).get("run_browser")?.requirements).toEqual(oneBrowser);
  });

  it("fails before allocation when browser resources differ from the owned profile", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await expect(
      orch.createIsolationBoundary("run_browser", {
        requirements: {
          ...oneBrowser,
          supplementalResources: { memoryBytes: 1, nanoCpus: 1, pidsLimit: 1 },
        },
      }),
    ).rejects.toThrow(/do not match/);
    expect(reservedIndexes(orch).size).toBe(0);
  });

  it("rejects client-requested resource inflation before allocation", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await expect(
      orch.createIsolationBoundary("run_browser", {
        requirements: {
          ...oneBrowser,
          supplementalResources: {
            memoryBytes: 64 * 1024 * 1024 * 1024,
            nanoCpus: 64_000_000_000,
            pidsLimit: 65_535,
          },
        },
      }),
    ).rejects.toThrow(/do not match/);
    expect(reservedIndexes(orch).size).toBe(0);
  });

  it("fails closed above the supported per-run instance bound", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await expect(
      orch.createIsolationBoundary("run_browser", {
        requirements: {
          capabilities: [{ kind: "browser", profile: "standard", instances: 5 }],
          supplementalResources: {
            memoryBytes: 5 * 1024 * 1024 * 1024,
            nanoCpus: 5_000_000_000,
            pidsLimit: 1280,
          },
        },
      }),
    ).rejects.toThrow(/maximum is 4/);
    expect(reservedIndexes(orch).size).toBe(0);
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

describe("runId charset guard", () => {
  it("rejects a runId that reaches outside the safe filesystem charset", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    // Dots are rejected too (RUN_ID_RE admits no `.` — kills `..` traversal).
    for (const bad of ["../escape", "a/b", "run 1", "run\0x", "run.1"]) {
      await expect(orch.createIsolationBoundary(bad)).rejects.toThrow(
        /safe run-identifier charset/,
      );
    }
    // Nothing was allocated for the rejected runs.
    expect(reservedIndexes(orch).size).toBe(0);
  });
});

describe("boundary-id path containment", () => {
  it("refuses to remove a boundary whose id resolves outside FIRECRACKER_DATA_DIR", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    // A crafted wire boundary — name matches no live VM, id points at host
    // state outside the run tree. The containment guard must throw before rm.
    await expect(
      orch.removeIsolationBoundary({
        id: "/etc",
        name: "firecracker-run_x",
        workspace: { kind: "directory", path: "/workspace" },
        sidecarEndpoints: {
          sidecarUrl: "http://127.0.0.1:8080",
          llmProxyUrl: "http://127.0.0.1:8080/llm",
          forwardProxyUrl: "http://127.0.0.1:8081",
          noProxy: "127.0.0.1",
        },
      }),
    ).rejects.toThrow(/outside\s+FIRECRACKER_DATA_DIR/);
  });

  it("removes a legitimately-contained boundary id", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const boundary = await orch.createIsolationBoundary("run_ok");
    // boundary.id is the run dir under dataDir — the guard admits it.
    await orch.removeIsolationBoundary(boundary);
    expect(await Bun.file(join(dataDir, "run_ok", "state.json")).exists()).toBe(false);
  });
});

describe("admission control (FIRECRACKER_MAX_CONCURRENT_VMS)", () => {
  it("refuses a new boundary once the cap is reached", async () => {
    process.env.FIRECRACKER_MAX_CONCURRENT_VMS = "1";
    _resetCacheForTesting();
    try {
      const { exec } = fakeExec();
      const orch = readyOrchestrator(exec);
      const b1 = await orch.createIsolationBoundary("run_1");
      await expect(orch.createIsolationBoundary("run_2")).rejects.toThrow(/at capacity/);
      // Freeing the slot admits the next run.
      await orch.removeIsolationBoundary(b1);
      await expect(orch.createIsolationBoundary("run_2")).resolves.toBeDefined();
    } finally {
      delete process.env.FIRECRACKER_MAX_CONCURRENT_VMS;
      _resetCacheForTesting();
    }
  });

  it("admits at most `maxVms` under concurrent creation (slot reserved before the awaits)", async () => {
    process.env.FIRECRACKER_MAX_CONCURRENT_VMS = "1";
    _resetCacheForTesting();
    try {
      const { exec } = fakeExec();
      const orch = readyOrchestrator(exec);
      // Both fire before either lands in `vms`. A plain `vms.size` gate
      // would let both through (TOCTOU); the synchronous reservation caps
      // it at one admission, one rejection.
      const results = await Promise.allSettled([
        orch.createIsolationBoundary("run_a"),
        orch.createIsolationBoundary("run_b"),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        message: expect.stringMatching(/at capacity/),
      });
      // Exactly one live VM, one reserved index — no overcommit leaked.
      expect(reservedIndexes(orch).size).toBe(1);
    } finally {
      delete process.env.FIRECRACKER_MAX_CONCURRENT_VMS;
      _resetCacheForTesting();
    }
  });
});

describe("pre-spawn state persistence", () => {
  it("records the api socket path before the VMM spawns (orphan-sweep anchor)", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_pre");
    const state = JSON.parse(
      await Bun.file(join(dataDir, "run_pre", "state.json")).text(),
    ) as Record<string, unknown>;
    // The socket path is on disk pre-spawn; the pid is not (added later by
    // startWorkload) — this is exactly the window the /proc fallback covers.
    expect(typeof state.apiSocketPath).toBe("string");
    expect(String(state.apiSocketPath)).toContain("afc-");
    expect(state.pid).toBeUndefined();
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

  it("leaves the host-lock pidfile alone (only run DIRECTORIES are swept)", async () => {
    const lockPath = join(dataDir, "orchestrator.pid");
    await writeFile(lockPath, String(process.pid));

    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const report = await orch.cleanupOrphans();

    expect(report.isolationBoundaries).toBe(0);
    expect(await Bun.file(lockPath).exists()).toBe(true);
  });
});

describe("orphan sweep containment (corrupted state.json)", () => {
  it("ignores a chrootPath outside the jail base as a jailed-VMM kill key", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const killed: number[] = [];
    Reflect.set(orch, "listProcPids", async () => [4242]);
    Reflect.set(orch, "pidLooksLikeVmmBinary", async () => true);
    Reflect.set(orch, "procRoot", async () => "/"); // the scanned VMM is rooted at /
    Reflect.set(orch, "procJailArgvId", async () => "otherjail");
    Reflect.set(orch, "killPid", (pid: number) => {
      killed.push(pid);
      return true;
    });
    const sweepJailedVmm = Reflect.get(orch, "sweepJailedVmm") as (
      this: FirecrackerOrchestrator,
      s: unknown,
    ) => Promise<number>;

    // chrootPath "/" resolves OUTSIDE the jail base — it must not become a
    // match key (procRoot="/" would otherwise reap every unjailed process).
    // jailId also mismatches, so nothing is killed.
    const outside = await sweepJailedVmm.call(orch, {
      runId: "run_evil",
      jailId: "jailZ",
      chrootPath: "/",
    });
    expect(outside).toBe(0);
    expect(killed).toEqual([]);

    // A chrootPath UNDER the jail base that equals the VMM's root DOES match —
    // containment narrows, it does not disable the sweep.
    const inBase = join(jailChrootBase(dataDir), "run_ok", "root");
    Reflect.set(orch, "procRoot", async () => inBase);
    const contained = await sweepJailedVmm.call(orch, {
      runId: "run_ok",
      jailId: "jailZ",
      chrootPath: inBase,
    });
    expect(contained).toBe(1);
    expect(killed).toEqual([4242]);
  });
});

describe("streamLogs partial-line cap", () => {
  it("flushes an overlong newline-less line instead of buffering it unbounded", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_1");
    // proc stays null → the tail loop sees "exited" and drains to EOF.
    const big = "x".repeat(100 * 1024);
    await writeFile(join(dataDir, "run_1", "console.log"), big);

    const chunks: string[] = [];
    for await (const line of orch.streamLogs({ id: "x", runId: "run_1", role: "agent" })) {
      chunks.push(line);
    }

    // Flushed mid-stream (not one giant buffered line), nothing lost.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(big);
    // Bounded by the 64 KiB flush cap + one 16 KiB read.
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(80 * 1024);
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
    const nftDelete = joined.indexOf("nft delete table ip appstrate_fc");
    expect(tapDelete).toBeGreaterThan(-1);
    expect(nftDelete).toBeGreaterThan(tapDelete);
    // The iptables FORWARD accepts are removed too (probe then delete).
    expect(joined).toContain("iptables -C FORWARD -i afc+ -j ACCEPT");
    // The run dir is gone.
    expect(await Bun.file(join(dataDir, "run_1", "state.json")).exists()).toBe(false);
  });
});

describe("remote platform URL override (deps.platformApiUrl)", () => {
  const REMOTE_URL = "http://172.17.0.1:3000";

  it("resolvePlatformApiUrl returns the override verbatim (no alias/PORT computation)", async () => {
    const { exec } = fakeExec();
    const orch = new FirecrackerOrchestrator({ hostExec: exec, platformApiUrl: REMOTE_URL });
    expect(await orch.resolvePlatformApiUrl()).toBe(REMOTE_URL);
  });

  it("keeps the lo-alias URL when no platformApiUrl is set (dev smoke-harness topology)", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    // Default FIRECRACKER_SUBNET_CIDR (10.231.0.0/16) → alias 10.231.255.1;
    // port comes from the platform env, not from any override machinery.
    await expect(orch.resolvePlatformApiUrl()).resolves.toMatch(/^http:\/\/10\.231\.255\.1:\d+$/);
  });

  it("defaults the port from the scheme (80 http / 443 https)", () => {
    const { exec } = fakeExec();
    const http = new FirecrackerOrchestrator({ hostExec: exec, platformApiUrl: "http://10.0.0.9" });
    expect(Reflect.get(http, "platformForward")).toEqual({ ip: "10.0.0.9", port: 80 });
    const https = new FirecrackerOrchestrator({
      hostExec: exec,
      platformApiUrl: "https://10.0.0.9",
    });
    expect(Reflect.get(https, "platformForward")).toEqual({ ip: "10.0.0.9", port: 443 });
  });

  it("rejects hostname URLs at construction — guests have no DNS resolver", () => {
    const { exec } = fakeExec();
    expect(
      () => new FirecrackerOrchestrator({ hostExec: exec, platformApiUrl: "http://myhost:3000" }),
    ).toThrow(/IPv4 literal.*no DNS resolver/s);
  });

  it("rejects out-of-range octets and unparseable URLs", () => {
    const { exec } = fakeExec();
    // The WHATWG parser rejects malformed numeric hosts outright — they
    // land in the "not a valid URL" bucket, same actionable hint.
    expect(
      () => new FirecrackerOrchestrator({ hostExec: exec, platformApiUrl: "http://999.0.0.1" }),
    ).toThrow(/not a valid URL.*http\(s\):\/\/<IPv4>\[:port\]/s);
    expect(
      () => new FirecrackerOrchestrator({ hostExec: exec, platformApiUrl: "not a url" }),
    ).toThrow(/not a valid URL.*http\(s\):\/\/<IPv4>\[:port\]/s);
  });

  it("rejects non-http(s) schemes with an actionable message", () => {
    const { exec } = fakeExec();
    expect(
      () => new FirecrackerOrchestrator({ hostExec: exec, platformApiUrl: "ftp://10.0.0.1:21" }),
    ).toThrow(/must use http or https/);
  });

  it("exempts the remote platform ip (not the lo alias) from the forward proxy", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec, { platformApiUrl: REMOTE_URL });
    const boundary = await orch.createIsolationBoundary("run_1");
    expect(boundary.sidecarEndpoints.noProxy).toBe("localhost,127.0.0.1,172.17.0.1");
  });

  it("keeps the lo alias in noProxy when no platformApiUrl is set (dev smoke-harness topology: lo-alias delivery)", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const boundary = await orch.createIsolationBoundary("run_1");
    expect(boundary.sidecarEndpoints.noProxy).toBe("localhost,127.0.0.1,10.231.255.1");
  });
});

describe("waitForExit without a booted VM", () => {
  it("reports a non-clean exit for an unknown run", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    expect(await orch.waitForExit({ id: "x", runId: "nope", role: "agent" })).toBe(1);
  });
});

describe("boot-window cancel latch (B4)", () => {
  // A boundary created but never started has a VmRecord with `proc: null`
  // — exactly the window where a cancel used to be a silent no-op and the
  // VM booted anyway. Both stop paths must latch `stopping` so
  // startWorkload's post-spawn recheck kills the just-spawned VMM.

  it("stopByRunId returns already_stopped AND latches stopping on a proc-less record", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_boot");

    expect(await orch.stopByRunId("run_boot")).toBe("already_stopped");

    const vm = vmsOf(orch).get("run_boot");
    expect(vm?.stopping).toBe(true);
    expect(vm?.teardownReason).toBe("watchdog-kill");
  });

  it("stopWorkload latches stopping on a proc-less record", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_boot2");

    await orch.stopWorkload({ id: "x", runId: "run_boot2", role: "agent" });

    expect(vmsOf(orch).get("run_boot2")?.stopping).toBe(true);
  });
});

describe("exit reaper (ROB-1 layer 2)", () => {
  it("reaps only records whose VMM exited past the threshold", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_stale");
    await orch.createIsolationBoundary("run_fresh");
    // A VMM that exited 6 min ago and was never claimed by any platform —
    // vs a live boundary (exitedAt undefined) the reaper must not touch.
    const stale = vmsOf(orch).get("run_stale");
    expect(stale).toBeDefined();
    if (stale) stale.exitedAt = Date.now() - 6 * 60_000;

    const reapExitedVms = Reflect.get(orch, "reapExitedVms") as (
      this: FirecrackerOrchestrator,
      now?: number,
    ) => Promise<number>;
    const reaped = await reapExitedVms.call(orch);

    expect(reaped).toBe(1);
    expect(vmsOf(orch).has("run_stale")).toBe(false);
    expect(vmsOf(orch).has("run_fresh")).toBe(true);
    // The stale run's workspace was reclaimed with the record.
    expect(await Bun.file(join(dataDir, "run_stale", "state.json")).exists()).toBe(false);
  });

  it("leaves a recently-exited record alone (the platform may still claim it)", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    await orch.createIsolationBoundary("run_recent");
    const recent = vmsOf(orch).get("run_recent");
    expect(recent).toBeDefined();
    if (recent) recent.exitedAt = Date.now() - 10_000;

    const reapExitedVms = Reflect.get(orch, "reapExitedVms") as (
      this: FirecrackerOrchestrator,
      now?: number,
    ) => Promise<number>;
    expect(await reapExitedVms.call(orch)).toBe(0);
    expect(vmsOf(orch).has("run_recent")).toBe(true);
  });

  it("reaps a never-booted boundary past the threshold — TAP, index and slot freed, runId creatable again", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);
    // Platform crash (or captured-bearer replay) right after the boundary
    // create: a VmRecord with `proc: null` and no VMM ever spawned — no
    // exit event can ever stamp `exitedAt`, so only its age can reap it.
    await orch.createIsolationBoundary("run_neverboot");
    expect(reservedIndexes(orch).size).toBe(1);

    const reapExitedVms = Reflect.get(orch, "reapExitedVms") as (
      this: FirecrackerOrchestrator,
      now?: number,
    ) => Promise<number>;

    // Within the threshold the boundary is left alone — the platform may
    // still be about to call startWorkload.
    expect(await reapExitedVms.call(orch)).toBe(0);
    expect(vmsOf(orch).has("run_neverboot")).toBe(true);

    // Past the threshold the reaper frees everything the create allocated.
    expect(await reapExitedVms.call(orch, Date.now() + 6 * 60_000)).toBe(1);
    expect(vmsOf(orch).has("run_neverboot")).toBe(false);
    expect(calls.filter((c) => c.cmd.join(" ") === "ip link del afc1")).toHaveLength(1);
    expect(reservedIndexes(orch).size).toBe(0);

    // The admission slot AND the per-runId guard are released — a fresh
    // run may reuse the id (the leaked boundary no longer pins them).
    await orch.createIsolationBoundary("run_neverboot");
    expect(vmsOf(orch).has("run_neverboot")).toBe(true);
    expect(reservedIndexes(orch).size).toBe(1);
  });

  it("wipes the run's credential-bearing pending maps when it reaps a never-booted boundary", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const pending = (name: string) => Reflect.get(orch, name) as Map<string, unknown>;

    // Boundary + sidecar + workload staged, but startWorkload never runs
    // (platform died) — so the run token / credential env sit in the pending
    // maps with a `proc: null` VmRecord.
    const boundary = await orch.createIsolationBoundary("run_leak");
    await orch.createSidecar("run_leak", boundary, { runToken: "secret-run-token" });
    await orch.createWorkload(
      {
        runId: "run_leak",
        role: "agent",
        image: "unused",
        env: { MODEL_API_KEY: "sk-secret" },
        resources: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000 },
      },
      boundary,
    );
    expect(pending("pendingSidecarEnv").has("run_leak")).toBe(true);
    expect(pending("pendingAgentSpecs").has("run_leak")).toBe(true);

    const reapExitedVms = Reflect.get(orch, "reapExitedVms") as (
      this: FirecrackerOrchestrator,
      now?: number,
    ) => Promise<number>;
    expect(await reapExitedVms.call(orch, Date.now() + 6 * 60_000)).toBe(1);

    // Reaping the record must also drop the secrets it never got to use —
    // otherwise they linger in daemon heap until restart.
    expect(pending("pendingSidecarEnv").has("run_leak")).toBe(false);
    expect(pending("pendingAgentSpecs").has("run_leak")).toBe(false);
  });
});

describe("create* admission gate (no orphan credential maps)", () => {
  const spec = {
    runId: "run_x",
    role: "agent",
    image: "img",
    env: { MODEL_API_KEY: "sk" },
    resources: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000 },
  };
  const endpoints = {
    sidecarUrl: "http://127.0.0.1:8080",
    llmProxyUrl: "http://127.0.0.1:8080/llm",
    forwardProxyUrl: "http://127.0.0.1:8081",
    noProxy: "127.0.0.1",
  };
  const boundary = {
    id: "/tmp/x",
    name: "firecracker-run_x",
    workspace: { kind: "directory" as const, path: "/workspace" },
    sidecarEndpoints: endpoints,
  };

  it("refuses createWorkload / createSidecar for a run with no boundary", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const pending = (name: string) => Reflect.get(orch, name) as Map<string, unknown>;

    await expect(orch.createWorkload(spec, boundary)).rejects.toThrow(/no isolation boundary/);
    await expect(
      orch.createSidecar("run_x", boundary, { runToken: "tok-secret-000000000000" }),
    ).rejects.toThrow(/no isolation boundary/);
    // The credential maps stayed empty — no orphan entry with no VmRecord.
    expect(pending("pendingSidecarEnv").size).toBe(0);
    expect(pending("pendingAgentSpecs").size).toBe(0);
  });

  it("accepts them once the boundary exists", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const live = await orch.createIsolationBoundary("run_x");
    await expect(orch.createWorkload({ ...spec }, live)).resolves.toMatchObject({ runId: "run_x" });
    await expect(
      orch.createSidecar("run_x", live, { runToken: "tok-secret-000000000000" }),
    ).resolves.toMatchObject({ role: "sidecar" });
  });
});

describe("workloadSpecSchema maxLifetimeSeconds (B2)", () => {
  const base = {
    runId: "run_1",
    role: "agent",
    image: "img",
    env: {},
    resources: { memoryBytes: 1024, nanoCpus: 1_000_000_000 },
  };

  it("accepts a positive integer ceiling (and its absence)", () => {
    expect(workloadSpecSchema.safeParse({ ...base, maxLifetimeSeconds: 3600 }).success).toBe(true);
    expect(workloadSpecSchema.safeParse(base).success).toBe(true);
  });

  it("rejects zero, negative and fractional ceilings", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(workloadSpecSchema.safeParse({ ...base, maxLifetimeSeconds: bad }).success).toBe(
        false,
      );
    }
  });
});

describe("jailer-mode boundary (FIRECRACKER_JAILER=on)", () => {
  // A SHORT root (mkdtemp under /tmp, not os.tmpdir()): the in-chroot API
  // socket host path is guarded against the AF_UNIX sun_path cap, and
  // macOS per-user tmpdirs (/var/folders/…) are long enough to trip it.
  let jailTestRoot: string;

  beforeEach(async () => {
    jailTestRoot = await mkdtemp("/tmp/fcj-");
    process.env.FIRECRACKER_DATA_DIR = join(jailTestRoot, "runs");
    process.env.FIRECRACKER_JAILER = "on";
    _resetCacheForTesting();
  });

  afterEach(async () => {
    await rm(jailTestRoot, { recursive: true, force: true });
  });

  it("persists the jail identity + in-chroot socket path, and owns the TAP by the jail uid", async () => {
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);
    const boundary = await orch.createIsolationBoundary("run_1");

    const state = JSON.parse(
      await Bun.file(join(jailTestRoot, "runs", "run_1", "state.json")).text(),
    ) as Record<string, unknown>;
    // jailId = short runId digest + the run's subnet index (jailer charset,
    // AF_UNIX socket-path budget, collision-proofing).
    const jailId = deriveJailId("run_1", 1);
    expect(state.jailId).toBe(jailId);
    expect(state.jailUid).toBe(200_001); // FIRECRACKER_JAIL_UID_BASE default + index 1
    const expectedRoot = join(jailTestRoot, "jail", "firecracker", jailId, "root");
    expect(state.chrootPath).toBe(expectedRoot);
    expect(state.apiSocketPath).toBe(join(expectedRoot, "run", "firecracker.socket"));
    // The unprivileged jailed VMM can only TUNSETIFF a TAP born as its own.
    expect(calls[0]?.stdin).toContain("tuntap add dev afc1 mode tap user 200001\n");
    expect(boundary.name).toBe("firecracker-run_1");
  });

  it("rejects a data dir whose jail socket path exceeds the AF_UNIX cap — fully rolled back", async () => {
    process.env.FIRECRACKER_DATA_DIR = join(jailTestRoot, "a".repeat(80), "runs");
    _resetCacheForTesting();
    const { exec, calls } = fakeExec();
    const orch = readyOrchestrator(exec);

    await expect(orch.createIsolationBoundary("run_1")).rejects.toThrow(/AF_UNIX/);

    // Index released, and the guard fired BEFORE any TAP was created.
    expect(reservedIndexes(orch).size).toBe(0);
    expect(calls.some((c) => c.cmd.join(" ") === "ip -batch -")).toBe(false);
  });

  it("removes the whole jail tree on boundary teardown", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const boundary = await orch.createIsolationBoundary("run_1");

    // Simulate the chroot a spawn would have populated.
    const jailDir = join(jailTestRoot, "jail", "firecracker", deriveJailId("run_1", 1));
    await mkdir(join(jailDir, "root", "run"), { recursive: true });
    await writeFile(join(jailDir, "root", "vmconfig.json"), "{}");

    await orch.removeIsolationBoundary(boundary);
    expect(await Bun.file(join(jailDir, "root", "vmconfig.json")).exists()).toBe(false);
    expect(await Bun.file(join(jailTestRoot, "runs", "run_1", "state.json")).exists()).toBe(false);
  });
});

describe("cleanupOrphans jail residue reclamation", () => {
  it("reclaims a jailed orphan's chroot tree recorded in state.json", async () => {
    // Isolated layout: runs + jail nested under one temp root so the
    // base sweep never touches a shared tmpdir.
    const root = await mkdtemp(join(tmpdir(), "fc-jail-sweep-"));
    process.env.FIRECRACKER_DATA_DIR = join(root, "runs");
    _resetCacheForTesting();
    try {
      const chrootPath = join(root, "jail", "firecracker", "run-jail-1", "root");
      await mkdir(join(chrootPath, "run"), { recursive: true });
      await writeFile(join(chrootPath, "config.img"), "secret");
      const runDir = join(root, "runs", "run_jail");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        runDir + "/state.json",
        JSON.stringify({
          runId: "run_jail",
          tapDevice: "afc12",
          apiSocketPath: join(chrootPath, "run", "firecracker.socket"),
          jailId: "run-jail-1",
          jailUid: 64_001,
          chrootPath,
        }),
      );

      const { exec, calls } = fakeExec();
      const orch = readyOrchestrator(exec);
      const report = await orch.cleanupOrphans();

      // No live VMM to kill (fail-closed on hosts without /proc), but the
      // run dir, TAP and the whole jail tree are reclaimed.
      expect(report.isolationBoundaries).toBe(1);
      expect(calls.map((c) => c.cmd.join(" "))).toContain("ip link del afc12");
      expect(await Bun.file(join(chrootPath, "config.img")).exists()).toBe(false);
      expect(await Bun.file(runDir + "/state.json").exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims state-less jail dirs left under the chroot base (crash before state write)", async () => {
    const root = await mkdtemp(join(tmpdir(), "fc-jail-base-"));
    process.env.FIRECRACKER_DATA_DIR = join(root, "runs");
    _resetCacheForTesting();
    try {
      await mkdir(join(root, "runs"), { recursive: true });
      const strayJail = join(root, "jail", "firecracker", "stray-7", "root");
      await mkdir(strayJail, { recursive: true });
      await writeFile(join(strayJail, "vmlinux"), "x");

      const { exec } = fakeExec();
      const orch = readyOrchestrator(exec);
      await orch.cleanupOrphans();

      expect(await Bun.file(join(strayJail, "vmlinux")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("MMDS credential broker (FIRECRACKER_CREDENTIAL_BROKER)", () => {
  const ORIGINAL_BROKER = process.env.FIRECRACKER_CREDENTIAL_BROKER;

  afterEach(() => {
    if (ORIGINAL_BROKER === undefined) delete process.env.FIRECRACKER_CREDENTIAL_BROKER;
    else process.env.FIRECRACKER_CREDENTIAL_BROKER = ORIGINAL_BROKER;
    _resetCacheForTesting();
  });

  /** Minimal BunProcess stand-in: no streams, already-exited (drainStream no-ops). */
  function fakeVmmProc(): unknown {
    return {
      pid: 4321,
      stderr: null,
      stdout: null,
      exited: Promise.resolve(0),
      exitCode: 0,
      kill() {},
    };
  }

  /**
   * Drive an orchestrator to `startWorkload(agent)` with the KVM-touching
   * seams stubbed: `spawnVmm` (no real VMM), `buildConfigDrive` (no
   * mkfs.ext4 on macOS CI), `startConsoleWatch` (no leaked timer). The MMDS
   * PUT stays live so the broker contract is what is exercised.
   */
  async function primeToStart(
    runId: string,
    mmdsPut: (socketPath: string, payload: unknown) => Promise<void>,
    withSidecar = true,
  ): Promise<{ orch: FirecrackerOrchestrator; start: () => Promise<void> }> {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec, {
      mmdsPut: mmdsPut as FirecrackerOrchestratorDeps["mmdsPut"],
    });
    Reflect.set(orch, "spawnVmm", async () => fakeVmmProc());
    Reflect.set(orch, "buildConfigDrive", async () => {});
    Reflect.set(orch, "startConsoleWatch", () => {});

    const boundary = await orch.createIsolationBoundary(runId);
    if (withSidecar) await orch.createSidecar(runId, boundary, { runToken: "broker-run-token" });
    const agent = await orch.createWorkload(
      {
        runId,
        role: "agent",
        image: "unused",
        env: withSidecar ? {} : { APPSTRATE_SINK_SECRET: "hmac" },
        resources: { memoryBytes: 256 * 1024 * 1024, nanoCpus: 1_000_000_000 },
      },
      boundary,
    );
    return { orch, start: () => orch.startWorkload(agent) };
  }

  it("PUTs the secret payload exactly once on the happy path (default broker)", async () => {
    delete process.env.FIRECRACKER_CREDENTIAL_BROKER; // default = mmds
    _resetCacheForTesting();
    const calls: Array<{ socketPath: string; payload: unknown }> = [];
    const { orch, start } = await primeToStart("run_mmds_ok", async (socketPath, payload) => {
      // Deep-copy: the orchestrator scrubs the payload in place after the
      // PUT, so a live reference would read back as blanked values.
      calls.push({ socketPath, payload: JSON.parse(JSON.stringify(payload)) });
    });
    await start();

    expect(calls).toHaveLength(1);
    const payload = calls[0]?.payload as { sidecar_env: Record<string, string> };
    // The run token was brokered via MMDS, not left on the drive.
    expect(payload.sidecar_env.RUN_TOKEN).toBe("broker-run-token");
    // The VM is live (not destroyed).
    expect((Reflect.get(orch, "vms") as Map<string, unknown>).size).toBe(1);
    await orch.shutdown();
  });

  it("destroys the VM and fails the run when the MMDS PUT never succeeds", async () => {
    delete process.env.FIRECRACKER_CREDENTIAL_BROKER;
    _resetCacheForTesting();
    let attempts = 0;
    const { orch, start } = await primeToStart("run_mmds_fail", async () => {
      attempts++;
      throw new Error("socket refused");
    });
    await expect(start()).rejects.toThrow(/MMDS credential injection failed/);
    // Retried (5 attempts) then gave up.
    expect(attempts).toBe(5);
    // Fail-closed: the VM was torn down, not left booted without credentials.
    expect((Reflect.get(orch, "vms") as Map<string, unknown>).size).toBe(0);
    await orch.shutdown();
  });

  it("never PUTs in config-drive mode (secrets ride the drive)", async () => {
    process.env.FIRECRACKER_CREDENTIAL_BROKER = "config-drive";
    _resetCacheForTesting();
    let called = 0;
    const { orch, start } = await primeToStart("run_drive", async () => {
      called++;
    });
    await start();
    expect(called).toBe(0);
    await orch.shutdown();
  });
});
