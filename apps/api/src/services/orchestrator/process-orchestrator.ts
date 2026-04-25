// SPDX-License-Identifier: Apache-2.0

/**
 * Process-based orchestrator — runs agents and sidecars as Bun subprocesses.
 * No Docker required. Suitable for development and trusted self-hosted environments.
 *
 * ⚠️ No container isolation: agents can access the local filesystem and network.
 *    Use only with trusted agent code.
 *
 * Stdout workaround (Bun ≤1.3.9): `Bun.spawn({ stdout: "pipe" })` returns a
 * ReadableStream that signals EOF prematurely when the event loop services
 * concurrent I/O (e.g. incoming HTTP requests while an agent run is in-flight).
 * The subprocess keeps running but the platform sees an empty stream → 0 tokens
 * → false "could not reach the LLM API" failure. Reproducible by opening any
 * page while a run is active. Agent stdout is therefore redirected to a file via
 * `Bun.file()` and tailed with a sequential read handle. Docker mode is unaffected
 * (logs are read via the Docker HTTP API, not a Bun pipe).
 * Re-test with `stdout: "pipe"` after upgrading Bun to check if the fix is still needed.
 */

import { mkdir, rm, readdir, open as fsOpen } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getEnv } from "@appstrate/env";
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

/** Poll interval for tailing the stdout file (ms). */
const TAIL_POLL_MS = 50;
/** Read buffer size for tailing (bytes). */
const TAIL_BUFFER_SIZE = 16_384;

type BunProcess = ReturnType<typeof Bun.spawn>;

interface ProcessHandle {
  proc: BunProcess | null;
  role: string;
  runId: string;
  workDir?: string;
  stdoutPath?: string;
  /**
   * Last N lines of drained stderr. Read by `streamLogs()` on exit so an
   * agent that dies before producing any stdout still surfaces a reason
   * upstream (the platform's `pi.ts` error log only reads stdout).
   */
  stderrTail?: string[];
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
    await Promise.all(
      handles.map(async ([_id, handle]) => {
        if (handle.proc) {
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
        }
        await this.removePidfile(handle.runId, handle.role);
      }),
    );
    this.processes.clear();
    this.pendingSpecs.clear();
    this.sidecarPorts.clear();
  }

  async ensureImages(_images: string[]): Promise<void> {
    // No-op — no images needed in process mode
  }

  /**
   * Reconcile orphans left over from a previous platform process.
   *
   * Mode `process` has no Docker label to scan, so every spawn writes a pidfile
   * inside its boundary directory (`./data/runs/<runId>/<role>.pid`). At boot,
   * every subdirectory of `DATA_DIR` is by definition orphaned — boot.ts has
   * already marked any in-progress runs as failed before we run, and the new
   * platform process holds no in-memory handles yet. We SIGKILL each pid that
   * is still alive and rm -rf the boundary directory.
   *
   * Best-effort throughout: an unreadable pidfile or a permission error never
   * blocks startup. Idempotent — calling twice in a row returns zeros on the
   * second call.
   */
  async cleanupOrphans(): Promise<CleanupReport> {
    let workloads = 0;
    let isolationBoundaries = 0;

    let entries: string[];
    try {
      entries = (await readdir(DATA_DIR)) as unknown as string[];
    } catch {
      return { workloads: 0, isolationBoundaries: 0 };
    }

    for (const name of entries) {
      const dir = join(DATA_DIR, name);
      const files = ((await readdir(dir).catch(() => [])) as unknown as string[]) ?? [];
      for (const f of files) {
        if (!f.endsWith(".pid")) continue;
        const text = await Bun.file(join(dir, f))
          .text()
          .catch(() => "");
        const pid = Number(text.trim());
        if (!Number.isFinite(pid) || pid <= 0) continue;
        try {
          process.kill(pid, 0);
        } catch {
          // Already dead — nothing to kill, but the pidfile still counts as a
          // recovered orphan boundary (handled by the rm -rf below).
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
          workloads++;
        } catch {
          // Race: died between the probe and the kill.
        }
      }
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      isolationBoundaries++;
    }

    return { workloads, isolationBoundaries };
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
    await this.writePidfile(runId, "sidecar", proc.pid);

    try {
      await this.waitForHealth(`http://localhost:${port}/health`, 5000);
    } catch (err) {
      // Health check failed — kill the spawned sidecar and purge state so the
      // process doesn't outlive the failed createSidecar call. Without this,
      // pi.ts's finally never sees a sidecarHandle and the leak persists.
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead
      }
      this.processes.delete(id);
      this.sidecarPorts.delete(runId);
      await this.removePidfile(runId, "sidecar");
      throw err;
    }
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

    this.pendingSpecs.set(id, { entrypoint: AGENT_ENTRY, workDir, env });
    this.processes.set(id, { proc: null, role: spec.role, runId: spec.runId, workDir });

    return { id, runId: spec.runId, role: spec.role };
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    const pending = this.pendingSpecs.get(handle.id);
    const ph = this.processes.get(handle.id);
    if (!pending || !ph) return;

    const stdoutPath = join(pending.workDir, ".stdout.jsonl");

    const proc = Bun.spawn(["bun", "run", pending.entrypoint], {
      cwd: pending.workDir,
      env: pending.env,
      stdout: Bun.file(stdoutPath),
      stderr: "pipe",
    });

    const stderrTail: string[] = [];
    ph.stderrTail = stderrTail;
    this.drainStderr(proc, handle.id, stderrTail);
    ph.proc = proc;
    ph.stdoutPath = stdoutPath;
    this.pendingSpecs.delete(handle.id);
    await this.writePidfile(handle.runId, ph.role, proc.pid);

    // Co-locate stderr with the exit code so a silent crash (zero
    // stdout, drained stderr arriving after the platform's
    // "exited non-zero" log) still surfaces a reason in the same place
    // operators look first. Fire-and-forget — this is a diagnostic-only
    // observer; the actual exit handling stays in pi.ts.
    proc.exited.then(async (code) => {
      if (code === 0) return;
      // Give the stderr drain a moment to flush remaining buffered lines
      // (the reader sees `done: true` only after the kernel closes the pipe).
      await new Promise((r) => setTimeout(r, 100));
      logger.error("Subprocess exited non-zero", {
        label: handle.id,
        runId: handle.runId,
        role: ph.role,
        exitCode: code,
        stderrTail: stderrTail.slice(-50).join("\n"),
      });
    });
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
    if (ph.role === "sidecar") this.sidecarPorts.delete(ph.runId);
    await this.removePidfile(ph.runId, ph.role);
  }

  async waitForExit(handle: WorkloadHandle): Promise<number> {
    const ph = this.processes.get(handle.id);
    if (!ph?.proc) return 1;
    return ph.proc.exited;
  }

  /** Tail the stdout file, yielding complete JSON lines until the process exits. */
  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    const ph = this.processes.get(handle.id);
    if (!ph?.stdoutPath || !ph?.proc) return;

    let exited = false;
    ph.proc.exited.then(() => {
      exited = true;
    });

    const fh = await fsOpen(ph.stdoutPath, "r");
    const buf = Buffer.alloc(TAIL_BUFFER_SIZE);
    const decoder = new TextDecoder();
    let partial = "";

    try {
      while (!signal?.aborted) {
        const { bytesRead } = await fh.read(buf, 0, buf.length);

        if (bytesRead > 0) {
          partial += decoder.decode(buf.subarray(0, bytesRead), { stream: true });
          const lines = partial.split("\n");
          partial = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length > 0) yield line;
          }
        } else if (exited) {
          if (partial.length > 0) yield partial;
          break;
        } else {
          await new Promise((r) => setTimeout(r, TAIL_POLL_MS));
        }
      }
    } finally {
      await fh.close();
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

  /**
   * In process mode agents run as host subprocesses — loopback reaches the
   * platform directly. No Docker bridge, no host alias needed.
   */
  async resolvePlatformApiUrl(): Promise<string> {
    return `http://localhost:${getEnv().PORT}`;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Persist a spawned subprocess's pid in its boundary directory so the next
   * platform boot can reconcile the orphan if this process is killed before
   * cleanup runs (SIGKILL, hot-reload crash, machine reboot).
   *
   * Best-effort: the pidfile is a recovery aid, not a correctness requirement.
   * A failed write only loses the boot-time orphan recovery for one process.
   */
  private async writePidfile(runId: string, role: string, pid: number): Promise<void> {
    try {
      await Bun.write(join(DATA_DIR, runId, `${role}.pid`), String(pid));
    } catch (err) {
      logger.warn("Failed to write sidecar/workload pidfile", {
        runId,
        role,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async removePidfile(runId: string, role: string): Promise<void> {
    await rm(join(DATA_DIR, runId, `${role}.pid`), { force: true }).catch(() => {});
  }

  private async findAvailablePort(retries = 3): Promise<number> {
    for (let attempt = 0; attempt < retries; attempt++) {
      const s1 = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = s1.port ?? 0;
      s1.stop(true);
      if (!port) continue;
      try {
        const s2 = Bun.serve({ port: port + 1, fetch: () => new Response() });
        s2.stop(true);
        return port;
      } catch {
        continue;
      }
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

  /**
   * Drain stderr from a subprocess. Each line is logged at warn level
   * for live tailing; the same line is appended to {@link tail} (capped
   * at the last 50 lines) so the platform can surface stderr in the
   * agent-exit error log even when the process dies before the live
   * warn lines reach the user's filtered view.
   */
  private drainStderr(proc: BunProcess, label: string, tail?: string[]): void {
    const stderr = proc.stderr;
    if (!stderr || typeof stderr === "number") return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const append = (line: string) => {
      logger.warn(`[process:${label}:stderr] ${line}`);
      if (tail) {
        tail.push(line);
        if (tail.length > 50) tail.shift();
      }
    };

    const drain = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) append(line);
          }
        }
        if (buf.trim()) append(buf);
      } catch {
        // Stream closed
      } finally {
        reader.releaseLock();
      }
    };
    drain().catch(() => {});
  }
}
