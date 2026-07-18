// SPDX-License-Identifier: Apache-2.0

/**
 * `firecracker` execution backend — a {@link RunOrchestrator} that owns
 * no VMs itself: every call is proxied over HTTP to a remote
 * `appstrate-runner` daemon which runs the real in-process Firecracker
 * orchestrator on a KVM-capable host. (The class name keeps the "Remote"
 * qualifier because it describes the topology — an HTTP client to a
 * daemon — not the adapter id, which is simply `firecracker`.)
 *
 * The wire protocol lives in `./runner/protocol.ts` (single source of
 * truth for both sides). Handles and boundaries cross the wire verbatim
 * and are opaque to this client — it never inspects TAP devices, PIDs or
 * console paths; the daemon owns all host state.
 *
 * Resilience posture: control-plane calls (create/start/stop) fail fast —
 * the run engine already handles launch errors. The two calls whose loss
 * would corrupt a run OUTCOME (`waitForExit`) or silently truncate run
 * logs (`streamLogs`) reconnect across daemon blips instead.
 */

import type {
  RunOrchestrator,
  WorkloadHandle,
  WorkloadSpec,
  IsolationBoundary,
  IsolationBoundaryOptions,
  SidecarLaunchSpec,
  CleanupReport,
  StopResult,
} from "@appstrate/core/platform-types";
import { getErrorMessage } from "@appstrate/core/errors";
import { logger } from "../../lib/logger.ts";
import type { BootHeartbeatOutcome } from "../../services/state/runs.ts";
import { getRemoteEnv, type RemoteRunnerEnv } from "./remote-env.ts";
import {
  RUNNER_ROUTES,
  RUNNER_PROTOCOL_VERSION,
  EXIT_LONG_POLL_MS,
  healthResponseSchema,
  isolationBoundarySchema,
  workloadHandleSchema,
  exitResponseSchema,
  stopResultResponseSchema,
  errorResponseSchema,
  logLineSchema,
  workloadStatusResponseSchema,
  workloadConsolePath,
} from "./runner/protocol.ts";

/** Default per-request timeout. Control-plane calls must not hang a run. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Exponential-backoff ceiling for waitForExit retries. */
const RETRY_MAX_MS = 30_000;
/** Consecutive reconnect attempts before giving up on a log stream. */
const MAX_STREAM_RECONNECTS = 5;
/**
 * Boot-phase synthetic-heartbeat interval (phase 4). Comfortably under the
 * platform stall threshold (`RUN_STALL_THRESHOLD_SECONDS`, default 60s) so
 * a slow-booting guest never trips the watchdog before it emits its first
 * real event.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
/** Console tail attached to an abnormally-exited run (bytes). */
const CONSOLE_EXCERPT_BYTES = 2 * 1024;
/**
 * Timeout for the best-effort abnormal-exit console fetch. Short and fully
 * guarded — this fetch runs after waitForExit resolves, so it must never
 * stall the platform's finalize path.
 */
const CONSOLE_FETCH_TIMEOUT_MS = 5_000;

/**
 * Boot-phase heartbeat outcome (phase 4) — single source of truth in
 * services/state/runs.ts (the pump bumps `runs.last_heartbeat_at`, the
 * exact column the stall watchdog reads; it stops when the guest starts
 * reporting or the sink closes). Re-exported so this module's public type
 * surface (RemoteOrchestratorDeps) is unchanged.
 */
export type { BootHeartbeatOutcome };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Extract `{ error }` from a non-2xx body, falling back to the status. */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const parsed = errorResponseSchema.safeParse(await res.json());
    if (parsed.success) return parsed.data.error;
  } catch {
    // Non-JSON error body (proxy HTML page, empty body) — keep the status.
  }
  return `HTTP ${res.status}`;
}

/** Parse one NDJSON log line; undefined on malformed lines (skipped). */
function parseLogLine(raw: string): string | undefined {
  try {
    const parsed = logLineSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.line : undefined;
  } catch {
    return undefined;
  }
}

export interface RemoteOrchestratorDeps {
  /**
   * Injected by tests — canned Response objects, no network. The init is
   * widened with Bun's `unix` extension: over a UDS runner URL every call
   * dials the socket instead of a TCP host.
   */
  fetchFn?: (input: string | URL, init?: RequestInit & { unix?: string }) => Promise<Response>;
  /**
   * Initial backoff (ms) for waitForExit retries and streamLogs
   * reconnect pauses. Injectable so tests exercise the retry paths
   * without real one-second sleeps. Production default: 1s.
   */
  retryBaseMs?: number;
  /** Boot-phase synthetic-heartbeat interval (ms). Default 15s. */
  heartbeatIntervalMs?: number;
  /**
   * Records a synthetic heartbeat for a run whose guest has not yet emitted
   * its first event, returning whether the boot window is still open. This
   * is the DB-backed `runs.last_heartbeat_at` bump the stall watchdog reads
   * (see `recordBootHeartbeat` in services/state/runs.ts). When ABSENT, the
   * boot-phase heartbeat pump is disabled entirely — so unit tests and the
   * real-client round-trip stay inert. Production wires it in index.ts.
   */
  recordBootHeartbeat?: (runId: string) => Promise<BootHeartbeatOutcome>;
  /**
   * Surfaces a console excerpt for an abnormally-exited run into the run's
   * platform-recorded error/log detail (a run_logs row, visible in the UI).
   * When ABSENT, abnormal-exit console capture is disabled. Production wires
   * it in index.ts.
   */
  recordConsoleExcerpt?: (runId: string, exitCode: number, excerpt: string) => Promise<void>;
}

export class RemoteFirecrackerOrchestrator implements RunOrchestrator {
  private readonly fetchFn: (
    input: string | URL,
    init?: RequestInit & { unix?: string },
  ) => Promise<Response>;
  private readonly retryBaseMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly recordBootHeartbeat:
    ((runId: string) => Promise<BootHeartbeatOutcome>) | undefined;
  private readonly recordConsoleExcerpt:
    ((runId: string, exitCode: number, excerpt: string) => Promise<void>) | undefined;
  /** resolvePlatformApiUrl cache — the answer is static per daemon. */
  private platformUrlPromise: Promise<string> | undefined;

  constructor(deps: RemoteOrchestratorDeps = {}) {
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.retryBaseMs = deps.retryBaseMs ?? 1_000;
    this.heartbeatIntervalMs = deps.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.recordBootHeartbeat = deps.recordBootHeartbeat;
    this.recordConsoleExcerpt = deps.recordConsoleExcerpt;
  }

  /**
   * Lazy env access — this is deliberately NOT read at construction:
   * the module registers this backend unconditionally, but only a
   * deployment that selects `RUN_ADAPTER=firecracker` (and thus calls
   * initialize()) must provide the variables.
   */
  private requireEnv(): RemoteRunnerEnv {
    try {
      return getRemoteEnv();
    } catch (err) {
      throw new Error(
        `firecracker backend is not configured: set FIRECRACKER_RUNNER_URL ` +
          `(http(s) address of the appstrate-runner daemon, or unix:///path.sock ` +
          `for a co-located daemon over a Unix socket) and FIRECRACKER_RUNNER_TOKEN ` +
          `(shared bearer secret, at least 16 chars). See ` +
          `apps/api/src/modules/firecracker/README.md. (${getErrorMessage(err)})`,
      );
    }
  }

  /**
   * One HTTP call to the daemon. Network failures are wrapped with the
   * daemon URL (the operator's first question is "which daemon?"); non-2xx
   * responses surface the daemon's `{ error }` message tagged with the
   * route so a failure is attributable without daemon-side log digging.
   */
  private async call(
    route: string,
    opts: {
      method?: "GET" | "POST";
      body?: unknown;
      /** null = no timeout (streaming responses outlive any fixed budget). */
      timeoutMs?: number | null;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    const env = this.requireEnv();
    const { method = "POST", body, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
    const signals: AbortSignal[] = [];
    if (signal) signals.push(signal);
    if (timeoutMs !== null) signals.push(AbortSignal.timeout(timeoutMs));

    // UDS: fetch still needs an http URL for routing/headers, but the
    // AUTHORITY is ignored — the connection dials the socket via Bun's
    // `unix` init. The fixed placeholder host keeps request lines stable.
    const baseUrl =
      env.transport.kind === "unix" ? "http://appstrate-runner" : env.FIRECRACKER_RUNNER_URL;
    let res: Response;
    try {
      res = await this.fetchFn(`${baseUrl}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${env.FIRECRACKER_RUNNER_TOKEN}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        ...(env.transport.kind === "unix" ? { unix: env.transport.socketPath } : {}),
      });
    } catch (err) {
      throw new Error(
        `appstrate-runner ${route}: request to ${env.FIRECRACKER_RUNNER_URL} failed ` +
          `(${getErrorMessage(err)}) — is appstrate-runner running and reachable?`,
      );
    }
    if (!res.ok) {
      throw new Error(`appstrate-runner ${route}: ${await readErrorMessage(res)}`);
    }
    return res;
  }

  /**
   * GET /v1/health and validate the payload — the single health round-trip
   * that both initialize() (the handshake) and resolvePlatformApiUrl() (the
   * guest-visible platform URL) share. Throws an actionable error when the
   * URL does not answer with a runner health payload.
   */
  private async fetchHealth() {
    const res = await this.call(RUNNER_ROUTES.health, { method: "GET" });
    const parsed = healthResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      const env = this.requireEnv();
      throw new Error(
        `appstrate-runner at ${env.FIRECRACKER_RUNNER_URL} returned an unexpected health ` +
          `payload — is this URL really an appstrate-runner daemon?`,
      );
    }
    return parsed.data;
  }

  /**
   * Handshake with the daemon. This is where a misconfigured deployment
   * fails — missing env vars, unreachable daemon, protocol drift — all
   * with actionable messages, BEFORE the first run is accepted.
   */
  async initialize(): Promise<void> {
    const env = this.requireEnv();
    const health = await this.fetchHealth();
    if (health.protocol !== RUNNER_PROTOCOL_VERSION) {
      throw new Error(
        `appstrate-runner at ${env.FIRECRACKER_RUNNER_URL}: daemon speaks protocol ` +
          `${health.protocol}, platform expects ${RUNNER_PROTOCOL_VERSION} — upgrade the older side`,
      );
    }
    if (!health.initialized) {
      throw new Error(
        `appstrate-runner at ${env.FIRECRACKER_RUNNER_URL} is up but its Firecracker ` +
          `orchestrator failed to initialize — check the daemon's logs (KVM, artifacts)`,
      );
    }
    // Cache the daemon's guest-visible platform URL from the same health
    // payload — resolvePlatformApiUrl() serves it without a second round-trip.
    this.platformUrlPromise = Promise.resolve(health.platformUrl);
    // Surface the daemon's boot-time guest-path self-verification
    // (net-probe.ts) on the platform side too, so an operator reading the
    // platform boot log sees whether guest→platform networking is proven
    // healthy without SSHing to the runner host. `guestPathVerified` null
    // = the daemon could not verify (tooling absent or platform down).
    logger.info("firecracker orchestrator connected", {
      url: env.FIRECRACKER_RUNNER_URL,
      protocol: health.protocol,
      platformReachable: health.platformReachable,
      guestPathVerified: health.guestPathVerified,
    });
  }

  /**
   * No-op ON PURPOSE: the daemon owns the host's VM lifecycle, and a
   * platform shutdown/redeploy must not SIGKILL in-flight microVMs from
   * here. Recovery of the runs this restart orphans happens at the NEXT
   * platform boot: the boot finalizer sweeps stale-heartbeat runs and
   * stops each one's workload via `stopByRunId` (see boot.ts), while the
   * daemon's own exit-reaper sweeps VMs whose run no platform ever
   * finalized. There is no live reattach (waitForExit/streamLogs) across
   * a platform restart.
   */
  async shutdown(): Promise<void> {}

  /**
   * Returns zeros ON PURPOSE, mirroring shutdown(): a host-wide sweep
   * triggered from a platform boot would SIGKILL live microVMs owned by
   * other in-flight runs (multi-instance deployments share the runner
   * host). Per-run reclamation happens elsewhere: the boot finalizer
   * calls `stopByRunId` for each orphaned run it finalizes (boot.ts),
   * and the daemon sweeps its own host at ITS boot (daemon.ts) plus
   * reaps exited VMs continuously via its exit-reaper.
   */
  async cleanupOrphans(): Promise<CleanupReport> {
    return { workloads: 0, isolationBoundaries: 0, workspaces: 0 };
  }

  /** No-op: guest images are baked into the daemon's rootfs at build time. */
  async ensureImages(_images: string[]): Promise<void> {}

  async createIsolationBoundary(
    runId: string,
    opts?: IsolationBoundaryOptions,
  ): Promise<IsolationBoundary> {
    const res = await this.call(RUNNER_ROUTES.createBoundary, { body: { runId, opts } });
    return isolationBoundarySchema.parse(await res.json());
  }

  async removeIsolationBoundary(boundary: IsolationBoundary): Promise<void> {
    await this.call(RUNNER_ROUTES.removeBoundary, { body: { boundary } });
  }

  async createSidecar(
    runId: string,
    boundary: IsolationBoundary,
    spec: SidecarLaunchSpec,
  ): Promise<WorkloadHandle> {
    const res = await this.call(RUNNER_ROUTES.createSidecar, { body: { runId, boundary, spec } });
    return workloadHandleSchema.parse(await res.json());
  }

  async createWorkload(spec: WorkloadSpec, boundary: IsolationBoundary): Promise<WorkloadHandle> {
    const res = await this.call(RUNNER_ROUTES.createWorkload, { body: { spec, boundary } });
    return workloadHandleSchema.parse(await res.json());
  }

  async startWorkload(handle: WorkloadHandle): Promise<void> {
    await this.call(RUNNER_ROUTES.startWorkload, { body: { handle } });
  }

  async stopWorkload(handle: WorkloadHandle, timeoutSeconds?: number): Promise<void> {
    await this.call(RUNNER_ROUTES.stopWorkload, { body: { handle, timeoutSeconds } });
  }

  async removeWorkload(handle: WorkloadHandle): Promise<void> {
    await this.call(RUNNER_ROUTES.removeWorkload, { body: { handle } });
  }

  /**
   * Long-poll the daemon until the workload exits. A request failure is
   * retried forever with exponential backoff (1s → 30s cap): the exit
   * code decides the run's terminal status, so the outcome must survive
   * a daemon restart or a network blip — giving up here would mark a
   * still-running (or already-finished) run as failed.
   */
  async waitForExit(handle: WorkloadHandle): Promise<number> {
    // Boot-phase liveness (phase 4): while the guest is still booting and
    // has not yet posted its first sink event, keep the run alive against
    // the platform stall watchdog with synthetic heartbeats — but only
    // while the daemon confirms the VMM is alive, so a dead VM is never
    // masked. The pump is inert when no recorder is wired (tests).
    const stopHeartbeat = this.startBootHeartbeat(handle);
    let code: number;
    try {
      code = await this.pollForExit(handle);
    } finally {
      stopHeartbeat();
    }
    // Abnormal exit (crash / kill / watchdog) — attach the console tail to
    // the run's platform-recorded detail. Best-effort: fully guarded and
    // time-boxed so a fetch failure never blocks or fails finalize.
    if (code !== 0) {
      await this.captureAbnormalConsole(handle, code).catch(() => {});
    }
    return code;
  }

  /** The exit long-poll loop, extracted so waitForExit can wrap it. */
  private async pollForExit(handle: WorkloadHandle): Promise<number> {
    let backoffMs = this.retryBaseMs;
    for (;;) {
      let res: Response;
      try {
        res = await this.call(RUNNER_ROUTES.waitForExit, {
          body: { handle },
          // The daemon holds the poll up to EXIT_LONG_POLL_MS before
          // answering { done: false } — budget headroom on top of that.
          timeoutMs: EXIT_LONG_POLL_MS + 15_000,
        });
      } catch (err) {
        logger.warn("firecracker: waitForExit request failed — retrying", {
          runId: handle.runId,
          workloadId: handle.id,
          backoffMs,
          error: getErrorMessage(err),
        });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, RETRY_MAX_MS);
        continue;
      }
      backoffMs = this.retryBaseMs;
      const exit = exitResponseSchema.parse(await res.json());
      if (exit.done) return exit.code;
    }
  }

  /**
   * Start the boot-phase synthetic-heartbeat pump for a run. Returns a stop
   * function (idempotent). Each tick: confirm the VMM is alive with the
   * daemon, and only then record a heartbeat — until the guest starts
   * reporting real events, the sink closes, or the VMM dies. A no-op when
   * `recordBootHeartbeat` is not wired.
   */
  private startBootHeartbeat(handle: WorkloadHandle): () => void {
    const record = this.recordBootHeartbeat;
    if (!record) return () => {};

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    const schedule = (): void => {
      if (!stopped) timer = setTimeout(tick, this.heartbeatIntervalMs);
    };
    const tick = (): void => {
      void (async () => {
        if (stopped) return;
        const alive = await this.workloadIsAlive(handle);
        if (stopped) return;
        // VMM confirmed dead — stop so the watchdog can catch a genuinely
        // hung run instead of us masking it. (waitForExit will resolve too.)
        if (alive === false) return stop();
        // Liveness unknown (daemon blip / older daemon without the probe) —
        // skip this beat rather than assume alive, and retry next tick.
        if (alive === null) return schedule();
        let outcome: BootHeartbeatOutcome;
        try {
          outcome = await record(handle.runId);
        } catch (err) {
          logger.warn("firecracker: boot heartbeat write failed — retrying", {
            runId: handle.runId,
            error: getErrorMessage(err),
          });
          return schedule();
        }
        if (stopped) return;
        // Guest now reporting or run closed — real liveness takes over.
        if (outcome !== "bumped") return stop();
        schedule();
      })();
    };
    schedule();
    return stop;
  }

  /**
   * Ask the daemon whether the workload's VMM is still alive. `null` means
   * the answer is unknown (request failed, or an older daemon 404s the
   * probe) — the caller degrades rather than guessing.
   */
  private async workloadIsAlive(handle: WorkloadHandle): Promise<boolean | null> {
    let res: Response;
    try {
      res = await this.call(RUNNER_ROUTES.workloadStatus, { body: { handle } });
    } catch {
      return null;
    }
    const parsed = workloadStatusResponseSchema.safeParse(await res.json().catch(() => undefined));
    return parsed.success ? parsed.data.running : null;
  }

  /** Fetch a small console tail and hand it to the injected recorder. */
  private async captureAbnormalConsole(handle: WorkloadHandle, exitCode: number): Promise<void> {
    const record = this.recordConsoleExcerpt;
    if (!record) return;
    const excerpt = await this.fetchConsoleExcerpt(handle);
    if (!excerpt) return;
    await record(handle.runId, exitCode, excerpt);
  }

  /** Best-effort console tail via the daemon's console route; undefined on any failure. */
  private async fetchConsoleExcerpt(handle: WorkloadHandle): Promise<string | undefined> {
    let res: Response;
    try {
      res = await this.call(
        `${workloadConsolePath(handle.runId)}?tailBytes=${CONSOLE_EXCERPT_BYTES}`,
        { method: "GET", timeoutMs: CONSOLE_FETCH_TIMEOUT_MS },
      );
    } catch {
      return undefined;
    }
    const text = await res.text().catch(() => "");
    return text.length > 0 ? text : undefined;
  }

  /**
   * NDJSON log stream. The daemon's `skip` parameter makes reconnection
   * lossless: on a mid-stream failure we reconnect asking it to skip the
   * lines already yielded. Up to {@link MAX_STREAM_RECONNECTS} consecutive
   * failed attempts (counter resets after any successful line) — a daemon
   * that is durably gone should fail the stream, not spin forever.
   */
  async *streamLogs(handle: WorkloadHandle, signal?: AbortSignal): AsyncGenerator<string> {
    let received = 0;
    let failures = 0;
    for (;;) {
      if (signal?.aborted) return;
      try {
        const res = await this.call(RUNNER_ROUTES.streamLogs, {
          body: { handle, skip: received },
          // No timeout: a healthy log stream legitimately outlives any
          // fixed budget (it lasts as long as the run does).
          timeoutMs: null,
          signal,
        });
        if (!res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            // Clean end of stream — flush a trailing unterminated line.
            const tail = buffer.trim();
            if (tail) {
              const line = parseLogLine(tail);
              if (line !== undefined) {
                received += 1;
                yield line;
              }
            }
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          // Buffer partial lines across chunks — a JSON object may be
          // split anywhere by the transport.
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const raw = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!raw) continue;
            const line = parseLogLine(raw);
            if (line === undefined) continue;
            received += 1;
            failures = 0;
            yield line;
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        failures += 1;
        if (failures > MAX_STREAM_RECONNECTS) {
          throw new Error(
            `appstrate-runner ${RUNNER_ROUTES.streamLogs}: log stream failed after ` +
              `${MAX_STREAM_RECONNECTS} reconnect attempts: ${getErrorMessage(err)}`,
          );
        }
        logger.warn("firecracker: log stream interrupted — reconnecting", {
          runId: handle.runId,
          workloadId: handle.id,
          received,
          attempt: failures,
          error: getErrorMessage(err),
        });
        await sleep(this.retryBaseMs);
      }
    }
  }

  async stopByRunId(runId: string, timeoutSeconds?: number): Promise<StopResult> {
    const res = await this.call(RUNNER_ROUTES.stopRun, { body: { runId, timeoutSeconds } });
    return stopResultResponseSchema.parse(await res.json()).result;
  }

  /**
   * The DAEMON answers this: the agent runs on the runner host, so "how
   * does the agent reach the platform" is a runner-side topology fact (its
   * configured platform URL), not something this process can guess. Served
   * from the /v1/health payload — primed by initialize(), or fetched on
   * demand here if resolve races ahead of it. Cached (the answer is static
   * for the daemon's lifetime); the cache is dropped on failure so a
   * transient error does not poison every subsequent run.
   */
  resolvePlatformApiUrl(): Promise<string> {
    this.platformUrlPromise ??= this.fetchHealth()
      .then((health) => health.platformUrl)
      .catch((err: unknown) => {
        this.platformUrlPromise = undefined;
        throw err;
      });
    return this.platformUrlPromise;
  }
}
