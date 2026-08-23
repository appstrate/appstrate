// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ProcessOrchestrator } from "../../src/services/orchestrator/process-orchestrator.ts";

const DATA_DIR = resolve("./data/runs");

let orchestrator: ProcessOrchestrator;

afterEach(async () => {
  await orchestrator?.shutdown();
});

/** Wipe DATA_DIR so each test starts from a known empty state. */
async function resetDataDir() {
  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
}

/** Where the orchestrator keeps a run's workspace — mirrors workspaceDirFor(). */
function workspaceDirFor(runId: string): string {
  return join(tmpdir(), `appstrate-ws-${runId}`);
}

/**
 * Write the ownership marker that tells a boot sweep which platform process
 * created a run. Mirrors what createIsolationBoundary writes.
 */
async function writeOwnerMarker(runId: string, ownerPid: number): Promise<void> {
  const dir = workspaceDirFor(runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, ".appstrate-owner"), String(ownerPid));
}

/** Spawn a long-lived child process and return its pid. Caller must kill it. */
function spawnSleeper(): number {
  const proc = Bun.spawn(["bun", "-e", "setInterval(()=>{},60000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!proc.pid) throw new Error("Failed to spawn sleeper");
  return proc.pid;
}

/** Wait for `process.kill(pid, 0)` to throw ESRCH (i.e. pid is gone). */
async function waitForExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe("ProcessOrchestrator", () => {
  describe("createIsolationBoundary / removeIsolationBoundary", () => {
    it("creates a directory and removes it", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();

      const boundary = await orchestrator.createIsolationBoundary("test-run-1");
      expect(boundary.name).toBe("process-test-run-1");
      expect(existsSync(boundary.id)).toBe(true);

      await orchestrator.removeIsolationBoundary(boundary);
      expect(existsSync(boundary.id)).toBe(false);
    });

    it("removeIsolationBoundary is idempotent", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();

      const boundary = await orchestrator.createIsolationBoundary("test-run-2");
      await orchestrator.removeIsolationBoundary(boundary);
      await orchestrator.removeIsolationBoundary(boundary); // should not throw
    });

    it("attaches a shared workspace directory under os.tmpdir()", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();

      const boundary = await orchestrator.createIsolationBoundary("test-run-ws");
      expect(boundary.workspace.kind).toBe("directory");
      if (boundary.workspace.kind !== "directory") throw new Error("unreachable");
      expect(boundary.workspace.path).toContain("appstrate-ws-test-run-ws");
      expect(existsSync(boundary.workspace.path)).toBe(true);

      await orchestrator.removeIsolationBoundary(boundary);
      expect(existsSync(boundary.workspace.path)).toBe(false);
    });

    it("advertises coherent loopback sidecar endpoints at boundary creation", async () => {
      // The sidecar port pair is allocated when the BOUNDARY is created (not
      // lazily in createSidecar) so pi.ts can bake the URLs into the agent
      // env before the sidecar exists — the parallel-boot ordering fix.
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();

      const boundary = await orchestrator.createIsolationBoundary("test-run-endpoints");
      const { sidecarUrl, llmProxyUrl, forwardProxyUrl, noProxy } = boundary.sidecarEndpoints;
      const port = Number(new URL(sidecarUrl).port);
      expect(port).toBeGreaterThan(0);
      expect(llmProxyUrl).toBe(`${sidecarUrl}/llm`);
      expect(new URL(forwardProxyUrl).port).toBe(String(port + 1));
      expect(noProxy).toContain("localhost");

      await orchestrator.removeIsolationBoundary(boundary);
    });
  });

  describe("ensureImages", () => {
    it("is a no-op", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.ensureImages(["some-image:latest"]); // should not throw
    });
  });

  describe("cleanupOrphans", () => {
    beforeEach(async () => {
      await resetDataDir();
    });

    it("returns zero workloads + boundaries when DATA_DIR is empty (workspace reap is incidental)", async () => {
      orchestrator = new ProcessOrchestrator();
      const report = await orchestrator.cleanupOrphans();
      expect(report.workloads).toBe(0);
      expect(report.isolationBoundaries).toBe(0);
      // Workspaces reap sweeps os.tmpdir() globally — concurrent tests
      // creating workspace dirs (or leftovers from prior runs) can
      // contribute, so we don't pin the count.
      expect(report.workspaces).toBeGreaterThanOrEqual(0);
    });

    it("removes a boundary directory whose pidfile points at a dead pid", async () => {
      const dir = join(DATA_DIR, "orphan-dead");
      await mkdir(dir, { recursive: true });
      // 99999999 is well above /proc/sys/kernel/pid_max defaults, so it's safe
      // to assume no live process owns it.
      await writeFile(join(dir, "sidecar.pid"), "99999999");

      orchestrator = new ProcessOrchestrator();
      const report = await orchestrator.cleanupOrphans();

      expect(report.isolationBoundaries).toBe(1);
      expect(report.workloads).toBe(0);
      expect(existsSync(dir)).toBe(false);
    });

    it("kills a live orphan process and removes its boundary directory", async () => {
      const pid = spawnSleeper();
      const dir = join(DATA_DIR, "orphan-live");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sidecar.pid"), String(pid));

      try {
        orchestrator = new ProcessOrchestrator();
        const report = await orchestrator.cleanupOrphans();

        expect(report.workloads).toBe(1);
        expect(report.isolationBoundaries).toBe(1);
        expect(existsSync(dir)).toBe(false);
        expect(await waitForExit(pid)).toBe(true);
      } finally {
        // Defensive: if the test fails, make sure we don't leak the sleeper.
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already dead
        }
      }
    });

    it("ignores malformed pidfiles but still wipes the boundary", async () => {
      const dir = join(DATA_DIR, "orphan-garbage");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sidecar.pid"), "not-a-pid");

      orchestrator = new ProcessOrchestrator();
      const report = await orchestrator.cleanupOrphans();

      expect(report.isolationBoundaries).toBe(1);
      expect(report.workloads).toBe(0);
      expect(existsSync(dir)).toBe(false);
    });

    it("preserves a boundary owned by a live sibling instance (#1130)", async () => {
      // The regression: DATA_DIR is cwd-relative, so two `bun run dev`
      // sessions from the same checkout share it. Booting the second one
      // SIGKILLed the first one's live agent and deleted its boundary —
      // the sweep probed `kill(pid, 0)`, saw the workload was ALIVE, and
      // killed it for exactly that reason.
      const workloadPid = spawnSleeper();
      const ownerPid = spawnSleeper();
      const runId = "sibling-live";
      const dir = join(DATA_DIR, runId);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sidecar.pid"), String(workloadPid));
      await writeOwnerMarker(runId, ownerPid);

      try {
        orchestrator = new ProcessOrchestrator();
        const report = await orchestrator.cleanupOrphans();

        expect(report.workloads).toBe(0);
        expect(report.isolationBoundaries).toBe(0);
        expect(existsSync(dir)).toBe(true);
        // The sibling's workload is still running.
        expect(() => process.kill(workloadPid, 0)).not.toThrow();
      } finally {
        await rm(workspaceDirFor(runId), { recursive: true, force: true });
        for (const pid of [workloadPid, ownerPid]) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already dead
          }
        }
      }
    });

    it("preserves the workspace of a live sibling started from another worktree (#1130)", async () => {
      // Worktrees get their own DATA_DIR but share os.tmpdir(), so the
      // workspace sweep is the one path that sees across them. It used to
      // `rm -rf` a running agent's /workspace mid-run: the uid filter it
      // relied on does not separate two instances run by the same user.
      const ownerPid = spawnSleeper();
      const runId = "sibling-worktree";
      const workspace = workspaceDirFor(runId);
      await mkdir(workspace, { recursive: true });
      await writeOwnerMarker(runId, ownerPid);
      await writeFile(join(workspace, "output.txt"), "work in progress");

      try {
        orchestrator = new ProcessOrchestrator();
        await orchestrator.cleanupOrphans();

        expect(existsSync(join(workspace, "output.txt"))).toBe(true);
      } finally {
        await rm(workspace, { recursive: true, force: true });
        try {
          process.kill(ownerPid, "SIGKILL");
        } catch {
          // Already dead
        }
      }
    });

    it("reclaims a workspace whose owning instance is gone (#1130)", async () => {
      // The other half of the invariant: a dead owner is what makes residue
      // reclaimable, so a crashed instance's leftovers must still be reaped.
      const runId = "owner-dead";
      const workspace = workspaceDirFor(runId);
      await mkdir(workspace, { recursive: true });
      await writeOwnerMarker(runId, 99999999);

      orchestrator = new ProcessOrchestrator();
      await orchestrator.cleanupOrphans();

      expect(existsSync(workspace)).toBe(false);
    });

    it("is idempotent — second call after a wipe returns zeros", async () => {
      const dir = join(DATA_DIR, "orphan-twice");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sidecar.pid"), "99999999");

      orchestrator = new ProcessOrchestrator();
      await orchestrator.cleanupOrphans();
      const second = await orchestrator.cleanupOrphans();
      // First sweep wiped the dir + any orphan workspaces; the second
      // call sees no boundary residue but tmpdir() workspaces from
      // *other* concurrent tests can still show up. Pin the boundary
      // + workload zeros; leave workspaces unconstrained.
      expect(second.workloads).toBe(0);
      expect(second.isolationBoundaries).toBe(0);
    });
  });

  describe("createSidecar (no health gate)", () => {
    beforeEach(async () => {
      await resetDataDir();
    });

    it("returns immediately, allocates a port, writes a pidfile, and registers in stopByRunId", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();
      const runId = "test-run-no-gate";
      const boundary = await orchestrator.createIsolationBoundary(runId);

      // Force the sidecar binary to a never-serves-/health script. Under the
      // previous health-gated contract this would have thrown after 5s; under
      // the new contract createSidecar must return immediately and the agent
      // owns the connect retry.
      const fakeSidecar = join(boundary.id, "fake-sidecar.ts");
      await writeFile(fakeSidecar, "setInterval(()=>{},60000);");

      const originalSpawn = Bun.spawn;
      let capturedPid: number | undefined;
      const patchedSpawn = ((cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => {
        const replaced = cmd[0] === "bun" && cmd[1] === "run" ? ["bun", "run", fakeSidecar] : cmd;
        const proc = originalSpawn(replaced, opts);
        capturedPid = proc.pid;
        return proc;
      }) as typeof Bun.spawn;
      (Bun as { spawn: typeof Bun.spawn }).spawn = patchedSpawn;

      const started = Date.now();
      try {
        const handle = await orchestrator.createSidecar(runId, boundary, { runToken: "tok" });
        const elapsed = Date.now() - started;
        // Fast-return invariant: well under the 5s the old health gate burned.
        expect(elapsed).toBeLessThan(1000);
        expect(handle.runId).toBe(runId);
        expect(handle.role).toBe("sidecar");
      } finally {
        (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      }

      expect(capturedPid).toBeDefined();
      // Pidfile was written under the boundary directory.
      const remaining = await readdir(boundary.id).catch(() => [] as string[]);
      expect(remaining.includes("sidecar.pid")).toBe(true);
      // stopByRunId finds the registered handle and reports stopped.
      expect(await orchestrator.stopByRunId(runId)).toBe("stopped");
      // The sidecar process is gone after stopByRunId.
      expect(await waitForExit(capturedPid!)).toBe(true);
    }, 10_000);

    it("defaults the sidecar's integration runtime adapter to 'process'", async () => {
      // A non-containerized (process) run must not let the sidecar auto-select
      // the Docker integration adapter (which needs the per-language runner
      // images). The orchestrator pins INTEGRATION_RUNTIME_ADAPTER=process so
      // integrations spawn as host subprocesses, matching the run itself.
      const runId = "test-run-integ-adapter";
      const boundary = await orchestrator.createIsolationBoundary(runId);
      const fakeSidecar = join(boundary.id, "fake-sidecar.ts");
      await writeFile(fakeSidecar, "setInterval(()=>{},60000);");

      const originalSpawn = Bun.spawn;
      let capturedEnv: Record<string, string> | undefined;
      const patchedSpawn = ((cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => {
        const replaced = cmd[0] === "bun" && cmd[1] === "run" ? ["bun", "run", fakeSidecar] : cmd;
        capturedEnv = (opts as { env?: Record<string, string> } | undefined)?.env;
        return originalSpawn(replaced, opts);
      }) as typeof Bun.spawn;
      (Bun as { spawn: typeof Bun.spawn }).spawn = patchedSpawn;
      try {
        await orchestrator.createSidecar(runId, boundary, { runToken: "tok" });
      } finally {
        (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      }
      expect(capturedEnv?.INTEGRATION_RUNTIME_ADAPTER).toBe("process");
      await orchestrator.stopByRunId(runId);
    }, 10_000);
  });

  describe("stopByRunId", () => {
    it("returns not_found for unknown run", async () => {
      orchestrator = new ProcessOrchestrator();
      const result = await orchestrator.stopByRunId("nonexistent-run");
      expect(result).toBe("not_found");
    });
  });

  describe("findAvailablePort (via createSidecar)", () => {
    it("allocates a port", async () => {
      orchestrator = new ProcessOrchestrator();

      // We test the port allocation indirectly — findAvailablePort is private,
      // but we can verify it works by checking the sidecar doesn't throw on port binding.
      // Since we can't easily test createSidecar without the sidecar binary,
      // we verify the port finder works standalone via reflection.
      const port = await (
        orchestrator as unknown as { findAvailablePort: () => Promise<number> }
      ).findAvailablePort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });
  });
});
