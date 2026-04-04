// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { ProcessOrchestrator } from "../../src/services/orchestrator/process-orchestrator.ts";

let orchestrator: ProcessOrchestrator;

afterEach(async () => {
  await orchestrator?.shutdown();
});

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
    it("returns zero counts", async () => {
      orchestrator = new ProcessOrchestrator();
      const report = await orchestrator.cleanupOrphans();
      expect(report).toEqual({ workloads: 0, isolationBoundaries: 0 });
    });
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
