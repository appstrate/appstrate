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

import { mkdir, rm, readdir, open as fsOpen, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getEnv } from "@appstrate/env";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import type {
  ContainerOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  InjectableFile,
  SidecarLaunchSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { applySpecToSidecarEnv } from "./sidecar-env.ts";

const DATA_DIR = resolve("./data/runs");
const SIDECAR_ENTRY = join(import.meta.dir, "../../../../../runtime-pi/sidecar/server.ts");
const AGENT_ENTRY = join(import.meta.dir, "../../../../../runtime-pi/entrypoint.ts");

/**
 * Naming prefix for per-run shared workspace directories. Mirrors the
 * Docker volume prefix in {@link docker.WORKSPACE_VOLUME_PREFIX} so the
 * boot-time orphan reaper can scan tmpdir() and reclaim leaked
 * directories from crashed runs using the same convention.
 */
const WORKSPACE_DIR_PREFIX = "appstrate-ws-";

/** Compute the host path for a run's workspace directory. */
function workspaceDirFor(runId: string): string {
  return join(tmpdir(), `${WORKSPACE_DIR_PREFIX}${runId}`);
}

/**
 * Scan `os.tmpdir()` for orphaned per-run workspace directories
 * (`appstrate-ws-*`) owned by THIS process's uid and remove them.
 * Boot-time recovery only — runs marked failed by `lib/boot.ts` are by
 * definition not holding any of these dirs, so removing them is safe.
 * Returns the count of dirs reclaimed for the {@link CleanupReport}.
 *
 * The uid filter avoids two problems on shared hosts:
 *   - Reaping a workspace owned by another platform instance (running
 *     as a different uid) — `rm` would silently fail with EPERM, but
 *     the noisy "skip" path would otherwise log dozens of unrelated
 *     directories per boot.
 *   - Counting other-uid dirs in the cleanup report, inflating the
 *     reclaimed total with directories we never touched.
 */
async function reapOrphanWorkspaceDirs(): Promise<number> {
  let entries: string[];
  try {
    entries = (await readdir(tmpdir())) as unknown as string[];
  } catch {
    return 0;
  }
  const myUid = process.getuid?.() ?? -1;
  let count = 0;
  for (const name of entries) {
    if (!name.startsWith(WORKSPACE_DIR_PREFIX)) continue;
    const path = join(tmpdir(), name);
    try {
      if (myUid >= 0) {
        const st = await stat(path);
        if (st.uid !== myUid) continue;
      }
      await rm(path, { recursive: true, force: true });
      count++;
    } catch {
      // Permission/stat errors — silently skip.
    }
  }
  return count;
}

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
      // Even when DATA_DIR is missing entirely, sweep tmpdir for
      // orphan workspace dirs from crashed runs — they live outside
      // DATA_DIR so the absence of DATA_DIR doesn't imply absence of
      // leaked workspaces.
      const workspaces = await reapOrphanWorkspaceDirs();
      return { workloads: 0, isolationBoundaries: 0, workspaces };
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

    const workspaces = await reapOrphanWorkspaceDirs();
    return { workloads, isolationBoundaries, workspaces };
  }

  async createIsolationBoundary(runId: string): Promise<IsolationBoundary> {
    const dir = join(DATA_DIR, runId);
    // Create both the pidfile boundary dir and the shared workspace
    // dir in parallel — independent fs operations, no ordering
    // constraint. Workspace lives under os.tmpdir() rather than
    // DATA_DIR so a host-side `rm -rf data/` doesn't accidentally
    // wipe the workspace for an active run.
    const workspacePath = workspaceDirFor(runId);
    await Promise.all([
      mkdir(dir, { recursive: true }),
      // 0o700: the workspace sits under the shared `os.tmpdir()` and
      // holds the agent's run inputs/outputs — keep it readable only by
      // the platform uid, not world-readable to other local users.
      mkdir(workspacePath, { recursive: true, mode: 0o700 }),
    ]);
    return {
      id: dir,
      name: `process-${runId}`,
      workspace: { kind: "directory", path: workspacePath },
    };
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    // Race boundary teardown and workspace teardown — independent
    // paths, errors swallowed individually so a stuck workspace can't
    // block the pidfile dir cleanup.
    await Promise.allSettled([
      rm(boundary.id, { recursive: true, force: true }),
      boundary.workspace.kind === "directory"
        ? rm(boundary.workspace.path, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
  }

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle> {
    const [port, platformApiUrl] = await Promise.all([
      this.findAvailablePort(),
      this.resolvePlatformApiUrl(),
    ]);
    const id = `sidecar-${runId}`;

    const env: Record<string, string> = {
      ...cleanProcessEnv(),
      PORT: String(port),
      PLATFORM_API_URL: platformApiUrl,
      RUN_TOKEN: spec.runToken,
      // Hand the workspace handle to the sidecar so its integration
      // runtime adapter can wire the same shared surface into runner
      // subprocesses that opt in via mcp-server _meta.workspace.
      WORKSPACE_HANDLE_JSON: JSON.stringify(boundary.workspace),
    };
    // This run is NOT containerized (process orchestrator), so its integrations
    // must spawn as host subprocesses too. The sidecar selects its integration
    // runtime purely from INTEGRATION_RUNTIME_ADAPTER (no auto-detection), so we
    // pin it to mirror this orchestrator's RUN_ADAPTER. Respect an explicit
    // operator override carried in from the environment.
    if (!env.INTEGRATION_RUNTIME_ADAPTER) {
      env.INTEGRATION_RUNTIME_ADAPTER = "process";
    }
    applySpecToSidecarEnv(spec, env);

    const proc = Bun.spawn(["bun", "run", SIDECAR_ENTRY], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.drainStderr(proc, id);
    // The sidecar's `info`-level lines go to stdout; drain them too so
    // the buffer never fills up (Bun pipes hang at ~64KB without a
    // reader, freezing whatever was about to be written next — e.g. the
    // integration-runtime's spawn progress logs).
    this.drainStderr(proc, id, undefined, "stdout");
    this.processes.set(id, { proc, role: "sidecar", runId });
    this.sidecarPorts.set(runId, port);
    await this.writePidfile(runId, "sidecar", proc.pid);

    // No /health gate — the agent's MCP client retries its handshake against
    // the sidecar's /mcp with AWS full-jitter backoff (50ms→1s, 30s deadline)
    // until the listener is up. Docker mode adopted the same contract in
    // issue #406; process mode now mirrors it. Removes the unconditional
    // ~200-500ms warm-path wait (5s on cold starts) from the run hot path.
    logger.info("Sidecar spawned", { runId, port, pid: proc.pid });

    return { id, runId, role: "sidecar" };
  }

  async seedWorkspace(boundary: IsolationBoundary, files: InjectableFile[]): Promise<void> {
    if (files.length === 0) return;
    if (boundary.workspace.kind !== "directory") {
      throw new Error(
        `process orchestrator expected a directory workspace, got '${boundary.workspace.kind}'`,
      );
    }
    // The agent's CWD is the boundary workspace directory; write the files
    // straight into it (no volume mount, no shadowing — the host filesystem
    // is the surface). Mirrors the Docker orchestrator's volume populate.
    for (const file of files) {
      const filePath = join(boundary.workspace.path, file.name);
      await mkdir(join(filePath, ".."), { recursive: true });
      await Bun.write(filePath, file.content);
    }
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    // The agent's workspace is the per-run shared directory created by
    // createIsolationBoundary so spawned mcp-server runner subprocesses
    // (which receive WORKSPACE_DIR via the sidecar) read and write the
    // exact same filesystem surface as the agent. Non-agent roles keep
    // the legacy per-boundary subdirectory.
    const workDir =
      spec.role === "agent" && boundary.workspace.kind === "directory"
        ? boundary.workspace.path
        : join(boundary.id, "workspace");
    await mkdir(workDir, { recursive: true });

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
        error: getErrorMessage(err),
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

  /**
   * Drain stderr from a subprocess. Each line is logged at warn level
   * for live tailing; the same line is appended to {@link tail} (capped
   * at the last 50 lines) so the platform can surface stderr in the
   * agent-exit error log even when the process dies before the live
   * warn lines reach the user's filtered view.
   */
  private drainStderr(
    proc: BunProcess,
    label: string,
    tail?: string[],
    stream: "stderr" | "stdout" = "stderr",
  ): void {
    const stderr = stream === "stderr" ? proc.stderr : proc.stdout;
    if (!stderr || typeof stderr === "number") return;

    const reader = (stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const append = (line: string) => {
      logger.warn(`[process:${label}:${stream}] ${line}`);
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
