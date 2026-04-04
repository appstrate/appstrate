// SPDX-License-Identifier: Apache-2.0

/**
 * Process-based orchestrator — runs agents and sidecars as Bun subprocesses.
 * No Docker required. Suitable for development and trusted self-hosted environments.
 *
 * ⚠️ No container isolation: agents can access the local filesystem and network.
 *    Use only with trusted agent code.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../lib/logger.ts";
import type { ContainerOrchestrator } from "./interface.ts";
import type {
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  SidecarConfig,
  CleanupReport,
  StopResult,
} from "./types.ts";

const DATA_DIR = "./data/runs";

interface ProcessHandle {
  proc: ReturnType<typeof Bun.spawn>;
  role: string;
  runId: string;
  workDir?: string;
}

export class ProcessOrchestrator implements ContainerOrchestrator {
  private processes = new Map<string, ProcessHandle>();
  private sidecarPorts = new Map<string, number>();

  async initialize(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    logger.warn(
      "⚠️  Running in PROCESS mode — agents execute without container isolation. " +
        "Use only with trusted agents in development or self-hosted environments.",
    );
  }

  async shutdown(): Promise<void> {
    // Kill all remaining processes
    for (const [id, handle] of this.processes) {
      try {
        handle.proc.kill("SIGTERM");
      } catch {
        // Already dead
      }
      this.processes.delete(id);
    }
    this.sidecarPorts.clear();
  }

  async ensureImages(_images: string[]): Promise<void> {
    // No-op — no images needed in process mode
  }

  async cleanupOrphans(): Promise<CleanupReport> {
    // No orphans possible — processes die with the parent
    return { workloads: 0, isolationBoundaries: 0 };
  }

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    const dir = join(DATA_DIR, runId);
    await mkdir(dir, { recursive: true });
    return { id: dir, name: `process-${runId}` };
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    try {
      await rm(boundary.id, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  async createSidecar(
    runId: string,
    _boundary: IsolationBoundary,
    config: SidecarConfig,
  ): Promise<WorkloadHandle> {
    const port = await this.findAvailablePort();
    const id = `sidecar-${runId}`;

    const sidecarBaseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) sidecarBaseEnv[k] = v;
    }
    const sidecarEnv: Record<string, string> = {
      ...sidecarBaseEnv,
      PORT: String(port),
      PLATFORM_API_URL: config.platformApiUrl,
      RUN_TOKEN: config.runToken,
    };
    if (config.proxyUrl) sidecarEnv.PROXY_URL = config.proxyUrl;
    if (config.llm) {
      sidecarEnv.PI_BASE_URL = config.llm.baseUrl;
      sidecarEnv.PI_API_KEY = config.llm.apiKey;
      sidecarEnv.PI_PLACEHOLDER = config.llm.placeholder;
    }

    const sidecarPath = join(import.meta.dir, "../../../../runtime-pi/sidecar/server.ts");
    const proc = Bun.spawn(["bun", "run", sidecarPath], {
      env: sidecarEnv,
      stdout: "ignore",
      stderr: "ignore",
    });

    this.processes.set(id, { proc, role: "sidecar", runId });
    this.sidecarPorts.set(runId, port);

    // Wait for sidecar to be ready
    await this.waitForHealth(`http://localhost:${port}/health`, 5000);

    return { id, runId, role: "sidecar" };
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    const workDir = join(boundary.id, "workspace");
    await mkdir(workDir, { recursive: true });

    // Write injected files to workspace
    if (spec.files) {
      for (const file of spec.files.items) {
        const filePath = join(workDir, file.name);
        const dir = join(filePath, "..");
        await mkdir(dir, { recursive: true });
        await Bun.write(filePath, file.content);
      }
    }

    const id = `workload-${spec.runId}-${spec.role}`;

    // Resolve sidecar URL for this run
    const sidecarPort = this.sidecarPorts.get(spec.runId);
    const sidecarUrl = sidecarPort ? `http://localhost:${sidecarPort}` : "http://localhost:8080";

    // Replace Docker sidecar URLs with localhost URLs
    // Filter out undefined values from process.env
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) baseEnv[k] = v;
    }
    const env: Record<string, string> = { ...baseEnv, ...spec.env };
    if (sidecarPort) {
      env.SIDECAR_URL = sidecarUrl;
      env.MODEL_BASE_URL = `${sidecarUrl}/llm`;
      env.HTTP_PROXY = `http://localhost:${sidecarPort + 1}`;
      env.HTTPS_PROXY = `http://localhost:${sidecarPort + 1}`;
      env.http_proxy = `http://localhost:${sidecarPort + 1}`;
      env.https_proxy = `http://localhost:${sidecarPort + 1}`;
      env.NO_PROXY = "localhost,127.0.0.1";
      env.no_proxy = "localhost,127.0.0.1";
    }

    const entrypoint = join(import.meta.dir, "../../../../runtime-pi/entrypoint.ts");
    const proc = Bun.spawn(["bun", "run", entrypoint], {
      cwd: workDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.processes.set(id, { proc, role: spec.role, runId: spec.runId, workDir });

    return { id, runId: spec.runId, role: spec.role };
  }

  async startWorkload(_handle: WorkloadHandle): Promise<void> {
    // In process mode, the workload is already started at creation (Bun.spawn is immediate).
    // This is a no-op to match the Docker pattern where create and start are separate.
  }

  async stopWorkload(handle: WorkloadHandle, timeoutSeconds = 5): Promise<void> {
    const ph = this.processes.get(handle.id);
    if (!ph) return;

    ph.proc.kill("SIGTERM");

    // Wait for graceful shutdown, then force kill
    const killed = await Promise.race([
      ph.proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), timeoutSeconds * 1000)),
    ]);

    if (!killed) {
      ph.proc.kill("SIGKILL");
    }
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    const ph = this.processes.get(handle.id);
    if (!ph) return;

    // Ensure process is dead
    try {
      ph.proc.kill("SIGKILL");
    } catch {
      // Already dead
    }

    this.processes.delete(handle.id);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    const ph = this.processes.get(handle.id);
    if (!ph) return 1;
    return ph.proc.exited;
  }

  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    const ph = this.processes.get(handle.id);
    if (!ph?.proc.stdout || typeof ph.proc.stdout === "number") return;

    const reader = (ph.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.length > 0) yield line;
        }
      }

      // Flush remaining buffer
      if (buffer.length > 0) yield buffer;
    } finally {
      reader.releaseLock();
    }
  }

  async stopByRunId(runId: string, timeoutSeconds?: number): Promise<StopResult> {
    let found = false;
    for (const [id, ph] of this.processes) {
      if (ph.runId === runId) {
        found = true;
        await this.stopWorkload({ id, runId, role: ph.role }, timeoutSeconds);
      }
    }
    return found ? "stopped" : "not_found";
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async findAvailablePort(): Promise<number> {
    // Use Bun's built-in server to find a free port
    const server = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = server.port ?? 0;
    server.stop(true);
    if (!port) throw new Error("Failed to find available port");
    return port;
  }

  private async waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const interval = 100;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, interval));
    }

    logger.warn("Sidecar health check timed out, proceeding anyway", { url, timeoutMs });
  }
}
