// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle tests for the FirecrackerOrchestrator's kill/cancel path —
 * the production stop flow (stopByRunId → killVm → SIGKILL), the
 * waitForExit fallback discrimination (nonce marker vs killed vs
 * crashed), and the orphan sweep's POSITIVE kill path (a recorded pid
 * that really IS a firecracker VMM must be killed — the existing tests
 * only cover the refusal side, so an always-false identity check would
 * silently leak VMMs).
 *
 * No KVM: the "VMM" is a real host subprocess (sleep/sh), the API socket
 * points at a path nothing listens on (so the graceful SendCtrlAltDel
 * PUT rejects immediately), and host commands are faked. Everything
 * asserted here is the orchestrator's contract, not VMM behavior.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetFirecrackerEnvCacheForTesting as _resetCacheForTesting } from "../../env.ts";
import { FirecrackerOrchestrator } from "../../orchestrator.ts";
import type { HostExec } from "../../host-net.ts";

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

type BunProcess = ReturnType<typeof Bun.spawn>;

/**
 * Structural view of the orchestrator's private VmRecord — only the
 * fields the kill/wait contract reads. Accessed via Reflect, same
 * precedent as firecracker-orchestrator.test.ts (`initialized`,
 * allocator internals).
 */
interface TestVmRecord {
  runId: string;
  runDir: string;
  consolePath: string;
  apiSocketPath: string;
  proc: BunProcess | null;
  stopping: boolean;
  exitNonce?: string;
}

function getVm(orch: FirecrackerOrchestrator, runId: string): TestVmRecord {
  const vms = Reflect.get(orch, "vms") as Map<string, TestVmRecord>;
  const vm = vms.get(runId);
  if (!vm) throw new Error(`no VmRecord for ${runId}`);
  return vm;
}

function readyOrchestrator(exec: HostExec): FirecrackerOrchestrator {
  const orch = new FirecrackerOrchestrator({ hostExec: exec });
  Reflect.set(orch, "initialized", true);
  return orch;
}

const ORIGINAL_DATA_DIR = process.env.FIRECRACKER_DATA_DIR;
let dataDir: string;
/** Real subprocesses standing in for VMMs — always reaped in afterEach. */
const spawned: BunProcess[] = [];
/** Extra temp dirs (decoy binaries) — outside dataDir so the sweep never counts them. */
const extraDirs: string[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "fc-life-test-"));
  process.env.FIRECRACKER_DATA_DIR = dataDir;
  _resetCacheForTesting();
});

afterEach(async () => {
  for (const proc of spawned) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead.
    }
  }
  spawned.length = 0;
  await rm(dataDir, { recursive: true, force: true });
  for (const dir of extraDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  extraDirs.length = 0;
});

afterAll(() => {
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.FIRECRACKER_DATA_DIR;
  else process.env.FIRECRACKER_DATA_DIR = ORIGINAL_DATA_DIR;
  _resetCacheForTesting();
});

/**
 * Boundary + a real live subprocess as the "VMM". The boundary's
 * apiSocketPath (tmpdir, per createIsolationBoundary) has no listener,
 * so killVm's graceful SendCtrlAltDel fetch rejects fast and the stop
 * path exercises its SIGKILL fallback — exactly the aarch64/dead-socket
 * production branch.
 */
async function liveVm(
  orch: FirecrackerOrchestrator,
  runId: string,
  argv: string[] = ["sleep", "30"],
): Promise<TestVmRecord> {
  await orch.createIsolationBoundary(runId);
  const vm = getVm(orch, runId);
  const proc = Bun.spawn(argv);
  spawned.push(proc);
  vm.proc = proc;
  vm.exitNonce = "0123456789abcdef0123456789abcdef";
  return vm;
}

describe("stopByRunId on a live VM", () => {
  it("SIGKILLs the VMM when the graceful shutdown cannot reach it, and waitForExit reports 137", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const vm = await liveVm(orch, "run_live");
    const proc = vm.proc!;

    // Production ordering: pi.ts is already awaiting waitForExit when the
    // cancel arrives.
    const handle = { id: "fc-run_live-agent", runId: "run_live", role: "agent" as const };
    const exitPromise = orch.waitForExit(handle);

    const result = await orch.stopByRunId("run_live", 1);

    expect(result).toBe("stopped");
    expect(vm.stopping).toBe(true);
    // The process is actually dead — killed, not exited on its own.
    await proc.exited;
    expect(proc.signalCode).toBe("SIGKILL");
    // No exit marker on the console + stopping=true → killed semantics.
    expect(await exitPromise).toBe(137);
  });

  it("discriminates not_found from already_stopped", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    expect(await orch.stopByRunId("run_unknown")).toBe("not_found");

    // Boundary exists but the VM never booted (proc still null).
    await orch.createIsolationBoundary("run_never_booted");
    expect(await orch.stopByRunId("run_never_booted")).toBe("already_stopped");
  });
});

describe("waitForExit fallback discrimination", () => {
  /** Boundary + an already-exited proc + a console we author ourselves. */
  async function exitedVm(orch: FirecrackerOrchestrator, runId: string): Promise<TestVmRecord> {
    await orch.createIsolationBoundary(runId);
    const vm = getVm(orch, runId);
    const proc = Bun.spawn(["sh", "-c", "exit 0"]);
    spawned.push(proc);
    await proc.exited;
    vm.proc = proc;
    vm.exitNonce = "feedfacefeedfacefeedfacefeedface";
    return vm;
  }

  const handle = (runId: string) => ({ id: `fc-${runId}-agent`, runId, role: "agent" as const });

  it("trusts the nonce-authenticated exit marker", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const vm = await exitedVm(orch, "run_marker");
    await writeFile(
      vm.consolePath,
      `[boot noise]\nworkload output\nAPPSTRATE_EXIT:${vm.exitNonce}:7\n`,
    );
    expect(await orch.waitForExit(handle("run_marker"))).toBe(7);
  });

  it("reports 137 when there is no marker and the run was being stopped", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const vm = await exitedVm(orch, "run_killed");
    await writeFile(vm.consolePath, "[boot noise]\nno marker here\n");
    vm.stopping = true;
    expect(await orch.waitForExit(handle("run_killed"))).toBe(137);
  });

  it("reports 1 when there is no marker and the run was NOT being stopped (crash)", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const vm = await exitedVm(orch, "run_crashed");
    await writeFile(vm.consolePath, "[boot noise]\nsupervisor never reported\n");
    expect(await orch.waitForExit(handle("run_crashed"))).toBe(1);
  });

  it("ignores a forged marker carrying the wrong nonce", async () => {
    const { exec } = fakeExec();
    const orch = readyOrchestrator(exec);
    const vm = await exitedVm(orch, "run_forged");
    // A workload printing a marker with a guessed nonce on the shared
    // serial console must not be able to fake a clean exit.
    await writeFile(vm.consolePath, "APPSTRATE_EXIT:deadbeefdeadbeefdeadbeefdeadbeef:0\n");
    expect(await orch.waitForExit(handle("run_forged"))).toBe(1);
  });
});

describe("cleanupOrphans positive kill path", () => {
  // Linux-only: pidIsOurVmm reads /proc/<pid>/cmdline, which does not
  // exist on macOS — there the guard refuses (fail-closed), which the
  // negative tests in firecracker-orchestrator.test.ts already cover.
  // This test DOES run in the Linux CI job (vm-smoke.sh runs the whole
  // directory), so an always-false identity check cannot regress silently.
  it.skipIf(process.platform !== "linux")(
    "kills a recorded pid whose /proc identity matches this run's VMM",
    async () => {
      // Decoy VMM: a copy of /bin/sh named "firecracker" parked in
      // sleep, with the recorded API socket path as a positional param —
      // its /proc/<pid>/cmdline then satisfies BOTH identity checks
      // (argv contains "firecracker", argv includes the socket path)
      // without needing KVM.
      const binDir = await mkdtemp(join(tmpdir(), "fc-decoy-"));
      extraDirs.push(binDir);
      const decoyBin = join(binDir, "firecracker");
      await Bun.write(decoyBin, Bun.file("/bin/sh"));
      await chmod(decoyBin, 0o755);
      const socketPath = join(binDir, "decoy-api.sock");
      const decoy = Bun.spawn([decoyBin, "-c", "sleep 30", "decoy", socketPath]);
      spawned.push(decoy);

      // Wait until /proc shows the post-exec argv (posix_spawn race).
      const cmdlineReady = async (): Promise<boolean> => {
        try {
          const cmdline = await Bun.file(`/proc/${decoy.pid}/cmdline`).text();
          const argv = cmdline.split("\0");
          return argv.some((a) => a.includes("firecracker")) && argv.includes(socketPath);
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 40 && !(await cmdlineReady()); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await cmdlineReady()).toBe(true);

      const runDir = join(dataDir, "run_orphan");
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, "state.json"),
        JSON.stringify({
          runId: "run_orphan",
          tapDevice: "afc9",
          pid: decoy.pid,
          apiSocketPath: socketPath,
        }),
      );

      const { exec, calls } = fakeExec();
      const orch = readyOrchestrator(exec);
      const report = await orch.cleanupOrphans();

      expect(report.workloads).toBe(1); // the kill was issued and counted
      expect(report.isolationBoundaries).toBe(1);
      await decoy.exited;
      expect(decoy.signalCode).toBe("SIGKILL");
      // The rest of the run's residue is reclaimed too.
      expect(calls.map((c) => c.cmd.join(" "))).toContain("ip link del afc9");
      expect(await Bun.file(join(runDir, "state.json")).exists()).toBe(false);
    },
  );
});
