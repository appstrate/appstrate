// SPDX-License-Identifier: Apache-2.0

/**
 * `firecracker-remote` execution backend (issue #819, phase 1) — a
 * {@link RunOrchestrator} that owns no VMs itself: every call is proxied
 * over HTTP to a remote `appstrate-runner` daemon which runs the real
 * in-process Firecracker orchestrator on a KVM-capable host.
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
import { getRemoteEnv, type RemoteRunnerEnv } from "./remote-env.ts";
import {
  RUNNER_ROUTES,
  RUNNER_PROTOCOL_VERSION,
  EXIT_LONG_POLL_MS,
  healthResponseSchema,
  cleanupReportSchema,
  isolationBoundarySchema,
  workloadHandleSchema,
  exitResponseSchema,
  stopResultResponseSchema,
  platformUrlResponseSchema,
  errorResponseSchema,
  logLineSchema,
} from "./runner/protocol.ts";

/** Default per-request timeout. Control-plane calls must not hang a run. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Exponential-backoff ceiling for waitForExit retries. */
const RETRY_MAX_MS = 30_000;
/** Consecutive reconnect attempts before giving up on a log stream. */
const MAX_STREAM_RECONNECTS = 5;

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
  /** Injected by tests — canned Response objects, no network. */
  fetchFn?: typeof fetch;
  /**
   * Initial backoff (ms) for waitForExit retries and streamLogs
   * reconnect pauses. Injectable so tests exercise the retry paths
   * without real one-second sleeps. Production default: 1s.
   */
  retryBaseMs?: number;
}

export class RemoteFirecrackerOrchestrator implements RunOrchestrator {
  private readonly fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly retryBaseMs: number;
  /** resolvePlatformApiUrl cache — the answer is static per daemon. */
  private platformUrlPromise: Promise<string> | undefined;

  constructor(deps: RemoteOrchestratorDeps = {}) {
    this.fetchFn = deps.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.retryBaseMs = deps.retryBaseMs ?? 1_000;
  }

  /**
   * Lazy env access — this is deliberately NOT read at construction:
   * the module registers this backend unconditionally, but only a
   * deployment that selects `RUN_ADAPTER=firecracker-remote` (and thus
   * calls initialize()) must provide the variables.
   */
  private requireEnv(): RemoteRunnerEnv {
    try {
      return getRemoteEnv();
    } catch (err) {
      throw new Error(
        `firecracker-remote backend is not configured: set FIRECRACKER_RUNNER_URL ` +
          `(http(s) address of the appstrate-runner daemon) and FIRECRACKER_RUNNER_TOKEN ` +
          `(shared bearer secret, at least 16 chars). See ` +
          `apps/api/src/modules/firecracker/runner/README.md. (${getErrorMessage(err)})`,
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

    let res: Response;
    try {
      res = await this.fetchFn(`${env.FIRECRACKER_RUNNER_URL}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${env.FIRECRACKER_RUNNER_TOKEN}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
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
   * Handshake with the daemon. This is where a misconfigured deployment
   * fails — missing env vars, unreachable daemon, protocol drift — all
   * with actionable messages, BEFORE the first run is accepted.
   */
  async initialize(): Promise<void> {
    const env = this.requireEnv();
    const res = await this.call(RUNNER_ROUTES.health, { method: "GET" });
    const parsed = healthResponseSchema.safeParse(await res.json().catch(() => undefined));
    if (!parsed.success) {
      throw new Error(
        `appstrate-runner at ${env.FIRECRACKER_RUNNER_URL} returned an unexpected health ` +
          `payload — is this URL really an appstrate-runner daemon?`,
      );
    }
    const health = parsed.data;
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
    logger.info("firecracker-remote orchestrator connected", {
      url: env.FIRECRACKER_RUNNER_URL,
      protocol: health.protocol,
    });
  }

  /**
   * No-op ON PURPOSE: the daemon owns its own lifecycle. Shutting down
   * (or redeploying) the platform must not kill remote microVMs — an
   * in-flight run keeps executing on the runner host, and the platform
   * reattaches via waitForExit/streamLogs after restart.
   */
  async shutdown(): Promise<void> {}

  /**
   * Proxied to the daemon, which sweeps ITS host. This assumes a single
   * platform per daemon (documented in runner/README.md) — with two
   * platforms sharing one daemon, one platform's boot would reap the
   * other's live runs.
   */
  async cleanupOrphans(): Promise<CleanupReport> {
    const res = await this.call(RUNNER_ROUTES.cleanupOrphans);
    return cleanupReportSchema.parse(await res.json());
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
        logger.warn("firecracker-remote: waitForExit request failed — retrying", {
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
        logger.warn("firecracker-remote: log stream interrupted — reconnecting", {
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
   * does the agent reach the platform" is a runner-side topology fact
   * (its configured platform URL), not something this process can guess.
   * Cached — the answer is static for the daemon's lifetime; the cache is
   * dropped on failure so a transient error does not poison every
   * subsequent run.
   */
  resolvePlatformApiUrl(): Promise<string> {
    this.platformUrlPromise ??= this.call(RUNNER_ROUTES.platformUrl, { method: "GET" })
      .then(async (res) => platformUrlResponseSchema.parse(await res.json()).url)
      .catch((err: unknown) => {
        this.platformUrlPromise = undefined;
        throw err;
      });
    return this.platformUrlPromise;
  }
}
