// SPDX-License-Identifier: Apache-2.0

/**
 * Process-based orchestrator — runs agents and sidecars as Bun subprocesses.
 * No Docker required. Suitable for development and trusted self-hosted environments.
 *
 * ⚠️ No container isolation: agents can access the local filesystem and network.
 *    Use only with trusted agent code.
 */

import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
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

const DATA_DIR = resolve("./data/runs");
const SIDECAR_ENTRY = join(import.meta.dir, "../../../../../runtime-pi/sidecar/server.ts");
const AGENT_ENTRY = join(import.meta.dir, "../../../../../runtime-pi/entrypoint.ts");

type BunProcess = ReturnType<typeof Bun.spawn>;

interface ProcessHandle {
  proc: BunProcess | null;
  role: string;
  runId: string;
  workDir?: string;
}

interface PendingSpec {
  entrypoint: string;
  workDir: string;
  env: Record<string, string>;
}

/** Build a clean env Record from process.env (filters out undefined values). */
function cleanProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export class ProcessOrchestrator implements ContainerOrchestrator {
  private processes = new Map<string, ProcessHandle>();
  private sidecarPorts = new Map<string, number>();
  private pendingSpecs = new Map<string, PendingSpec>();

  async initialize(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    logger.warn(
      "Running in PROCESS mode — agents execute without container isolation. " +
        "Use only with trusted agents in development or self-hosted environments.",
    );
  }

  async shutdown(): Promise<void> {
    const handles = [...this.processes.entries()];
    // Stop all processes in parallel with SIGTERM → SIGKILL escalation
    await Promise.all(
      handles.map(async ([_id, handle]) => {
        if (!handle.proc) return;
        try {
          handle.proc.kill("SIGTERM");
          const exited = await Promise.race([
            handle.proc.exited.then(() => true),
            new Promise<false>((r) => setTimeout(() => r(false), 5000)),
          ]);
          if (!exited) handle.proc.kill("SIGKILL");
        } catch {
          // Already dead
        }
      }),
    );
    this.processes.clear();
    this.pendingSpecs.clear();
    this.sidecarPorts.clear();
  }

  async ensureImages(_images: string[]): Promise<void> {
    // No-op — no images needed in process mode
  }

  async cleanupOrphans(): Promise<CleanupReport> {
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

    const env: Record<string, string> = {
      ...cleanProcessEnv(),
      PORT: String(port),
      PLATFORM_API_URL: config.platformApiUrl,
      RUN_TOKEN: config.runToken,
    };
    if (config.proxyUrl) env.PROXY_URL = config.proxyUrl;
    if (config.llm) {
      env.PI_BASE_URL = config.llm.baseUrl;
      env.PI_API_KEY = config.llm.apiKey;
      env.PI_PLACEHOLDER = config.llm.placeholder;
    }

    const proc = Bun.spawn(["bun", "run", SIDECAR_ENTRY], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.drainStderr(proc, id);
    this.processes.set(id, { proc, role: "sidecar", runId });
    this.sidecarPorts.set(runId, port);

    await this.waitForHealth(`http://localhost:${port}/health`, 5000);
    logger.info("Sidecar ready", { runId, port, pid: proc.pid });

    return { id, runId, role: "sidecar" };
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    const workDir = join(boundary.id, "workspace");
    await mkdir(workDir, { recursive: true });

    if (spec.files) {
      for (const file of spec.files.items) {
        const filePath = join(workDir, file.name);
        await mkdir(join(filePath, ".."), { recursive: true });
        await Bun.write(filePath, file.content);
      }
    }

    const id = `workload-${spec.runId}-${spec.role}`;
    const sidecarPort = this.sidecarPorts.get(spec.runId);
    const sidecarUrl = sidecarPort ? `http://localhost:${sidecarPort}` : "http://localhost:8080";

    const env: Record<string, string> = { ...cleanProcessEnv(), ...spec.env };
    env.WORKSPACE_DIR = resolve(workDir);
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

    // Store spec for deferred spawn in startWorkload (matches Docker create/start pattern)
    this.pendingSpecs.set(id, { entrypoint: AGENT_ENTRY, workDir, env });
    this.processes.set(id, { proc: null, role: spec.role, runId: spec.runId, workDir });

    return { id, runId: spec.runId, role: spec.role };
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    const pending = this.pendingSpecs.get(handle.id);
    const ph = this.processes.get(handle.id);
    if (!pending || !ph) return;

    const proc = Bun.spawn(["bun", "run", pending.entrypoint], {
      cwd: pending.workDir,
      env: pending.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.drainStderr(proc, handle.id);
    ph.proc = proc;
    this.pendingSpecs.delete(handle.id);
  }

  async stopWorkload(handle: WorkloadHandle, timeoutSeconds = 5): Promise<void> {
    const ph = this.processes.get(handle.id);
    if (!ph?.proc) return;

    ph.proc.kill("SIGTERM");
    const killed = await Promise.race([
      ph.proc.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), timeoutSeconds * 1000)),
    ]);
    if (!killed) ph.proc.kill("SIGKILL");
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    const ph = this.processes.get(handle.id);
    if (!ph) return;
    try {
      ph.proc?.kill("SIGKILL");
    } catch {
      // Already dead
    }
    this.processes.delete(handle.id);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    const ph = this.processes.get(handle.id);
    if (!ph?.proc) return 1;
    return ph.proc.exited;
  }

  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    const ph = this.processes.get(handle.id);
    if (!ph?.proc?.stdout || typeof ph.proc.stdout === "number") return;

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

  private async findAvailablePort(retries = 3): Promise<number> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const server = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = server.port ?? 0;
      server.stop(true);
      if (port) return port;
    }
    throw new Error("Failed to find available port after retries");
  }

  private async waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Sidecar health check timed out after ${timeoutMs}ms (${url})`);
  }

  /** Drain stderr from a subprocess and log each line. */
  private drainStderr(proc: BunProcess, label: string): void {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const drain = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) logger.warn(`[process:${label}:stderr] ${line}`);
          }
        }
        if (buf.trim()) logger.warn(`[process:${label}:stderr] ${buf}`);
      } catch {
        // Stream closed
      } finally {
        reader.releaseLock();
      }
    };
    drain().catch(() => {});
  }
}
