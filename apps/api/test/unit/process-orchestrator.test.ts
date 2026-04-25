// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile, readdir } from "node:fs/promises";
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
  });

  describe("createWorkload", () => {
    it("writes injected files to workspace", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();

      const boundary = await orchestrator.createIsolationBoundary("test-run-3");

      const handle = await orchestrator.createWorkload(
        {
          runId: "test-run-3",
          role: "agent",
          image: "unused-in-process-mode",
          env: { TEST_VAR: "hello" },
          resources: { memoryBytes: 0, nanoCpus: 0 },
          files: {
            items: [
              { name: "agent-package.afps", content: Buffer.from("fake-zip") },
              { name: "documents/readme.md", content: Buffer.from("# Test") },
            ],
            targetDir: "/workspace",
          },
        },
        boundary,
      );

      expect(handle.runId).toBe("test-run-3");
      expect(handle.role).toBe("agent");

      // Verify files were written
      const workDir = `${boundary.id}/workspace`;
      expect(existsSync(`${workDir}/agent-package.afps`)).toBe(true);
      expect(existsSync(`${workDir}/documents/readme.md`)).toBe(true);

      // Cleanup: kill the spawned process
      await orchestrator.removeWorkload(handle);
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

    it("returns zero counts when DATA_DIR is empty", async () => {
      orchestrator = new ProcessOrchestrator();
      const report = await orchestrator.cleanupOrphans();
      expect(report).toEqual({ workloads: 0, isolationBoundaries: 0 });
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

    it("is idempotent — second call after a wipe returns zeros", async () => {
      const dir = join(DATA_DIR, "orphan-twice");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "sidecar.pid"), "99999999");

      orchestrator = new ProcessOrchestrator();
      await orchestrator.cleanupOrphans();
      const second = await orchestrator.cleanupOrphans();
      expect(second).toEqual({ workloads: 0, isolationBoundaries: 0 });
    });
  });

  describe("createSidecar failure path", () => {
    beforeEach(async () => {
      await resetDataDir();
    });

    it("kills the spawned sidecar and removes its pidfile when health check fails", async () => {
      orchestrator = new ProcessOrchestrator();
      await orchestrator.initialize();
      const boundary = await orchestrator.createIsolationBoundary("test-run-health-fail");

      // Force the sidecar binary to a no-op script that never serves /health.
      // The path lives inside the boundary so it's cleaned up with the run.
      const fakeSidecar = join(boundary.id, "fake-sidecar.ts");
      await writeFile(fakeSidecar, "setInterval(()=>{},60000);");

      // Reflectively swap the sidecar entry path. We can't override the module
      // constant, so we monkey-patch Bun.spawn for this single call.
      const originalSpawn = Bun.spawn;
      let capturedPid: number | undefined;
      const patchedSpawn = ((cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => {
        const replaced = cmd[0] === "bun" && cmd[1] === "run" ? ["bun", "run", fakeSidecar] : cmd;
        const proc = originalSpawn(replaced, opts);
        capturedPid = proc.pid;
        return proc;
      }) as typeof Bun.spawn;
      (Bun as { spawn: typeof Bun.spawn }).spawn = patchedSpawn;

      try {
        await expect(
          orchestrator.createSidecar("test-run-health-fail", boundary, {
            runToken: "tok",
            platformApiUrl: "http://localhost:1",
          }),
        ).rejects.toThrow(/health check timed out/i);
      } finally {
        (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      }

      expect(capturedPid).toBeDefined();
      // The sidecar process should be dead.
      expect(await waitForExit(capturedPid!)).toBe(true);
      // No leftover pidfile under the boundary.
      const remaining = await readdir(boundary.id).catch(() => [] as string[]);
      expect(remaining.includes("sidecar.pid")).toBe(false);
      // stopByRunId should now report not_found — internal map is purged.
      expect(await orchestrator.stopByRunId("test-run-health-fail")).toBe("not_found");

      await orchestrator.removeIsolationBoundary(boundary);
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
