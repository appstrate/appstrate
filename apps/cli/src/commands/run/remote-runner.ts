// SPDX-License-Identifier: Apache-2.0

/**
 * `runRemote` — remote execution path for `appstrate run`.
 *
 * Trigger: `POST /api/agents/:scope/:name/run` returns `{ runId }` and
 * the platform spawns a Pi container (same path as the dashboard "Run"
 * button). The CLI then tails the run by polling two endpoints:
 *
 *   - `GET /api/runs/:runId/logs` — append-only run-log entries for
 *     incremental rendering.
 *   - `GET /api/runs/:runId`      — terminal-status detection + the
 *     final RunResult/error/cost reconciliation.
 *
 * Polling (rather than SSE) is the v1 transport because the realtime
 * endpoint's `validateSSEAuth` (apps/api/src/routes/realtime.ts) only
 * accepts API-key tokens and cookie sessions — interactive CLI auth
 * uses Bearer JWTs, which the standard auth pipeline accepts on
 * `/api/runs/...` but not on the SSE handler. Polling sidesteps this
 * cleanly without any server change. Migrating to SSE later is a pure
 * client-side swap behind the same `runRemote()` entry point.
 *
 * Cancellation: on `signal` abort the runner POSTs `/api/runs/:id/cancel`
 * once and continues polling until the run reaches a terminal status.
 * Idempotency-Key on the trigger POST guards against accidental double
 * submission across CLI retries.
 */

const TERMINAL_STATUSES = new Set(["success", "failed", "timeout", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type TerminalRunStatus = "success" | "failed" | "timeout" | "cancelled";
export type RunStatus = "pending" | "running" | TerminalRunStatus;

/** Subset of the `runs` row returned by `GET /api/runs/:id`. */
export interface RemoteRunRecord {
  id: string;
  status: RunStatus;
  packageId: string;
  applicationId: string;
  orgId: string;
  input?: unknown;
  result?: unknown;
  error?: string | null;
  checkpoint?: unknown;
  cost?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  duration?: number | null;
  versionLabel?: string | null;
  modelLabel?: string | null;
  modelSource?: string | null;
}

/** Subset of a `run_logs` row returned by `GET /api/runs/:id/logs`. */
export interface RemoteRunLog {
  id: number;
  runId: string;
  type: string;
  event: string | null;
  message: string | null;
  data?: unknown;
  level: "debug" | "info" | "warn" | "error";
  createdAt?: string;
}

export interface RemoteRunOutcome {
  runId: string;
  status: TerminalRunStatus;
  /** Final run record fetched from `GET /api/runs/:id`. */
  record: RemoteRunRecord;
  /** All logs accumulated during the run. */
  logs: RemoteRunLog[];
  /**
   * Process exit code suggested by the outcome. `0` for success,
   * `1` for any non-success terminal status (cancelled / failed / timeout).
   */
  exitCode: number;
}

export class RemoteRunError extends Error {
  override readonly name = "RemoteRunError";
  readonly hint?: string;
  readonly status?: number;
  readonly body?: unknown;
  constructor(message: string, opts: { hint?: string; status?: number; body?: unknown } = {}) {
    super(message);
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.body !== undefined) this.body = opts.body;
  }
}

export interface RunRemoteOptions {
  /** Pinned instance origin (e.g. `https://app.example.com`). */
  instance: string;
  /** Bearer token (`ask_…` or OIDC JWT). */
  bearerToken: string;
  /** Application id (`X-App-Id`). */
  appId: string;
  /** Organization id (`X-Org-Id`). Required for cookie/JWT auth contexts. */
  orgId?: string | undefined;

  /** Agent scope (`@scope`). */
  scope: string;
  /** Agent name (no scope). */
  name: string;
  /** Optional `?version=` override forwarded to the trigger endpoint. */
  spec?: string | undefined;

  /** Run input — forwarded to the trigger body. */
  input: Record<string, unknown>;
  /** Run config override — forwarded to the trigger body (deep-merged server-side). */
  config: Record<string, unknown>;
  /** Model id override (or `null` to clear). */
  modelId?: string | null;
  /** Proxy id override (or `"none"` to disable). */
  proxyId?: string | null;

  /** `Idempotency-Key` for the trigger POST. */
  idempotencyKey?: string | undefined;

  /** When true, emit each event as JSONL on stdout. Otherwise human-format. */
  json: boolean;
  /** Optional path — final RunResult JSON written here. */
  outputPath?: string | undefined;
  /** Label printed on the "→ running …" stderr line. */
  bundleLabel: string;

  // ─── Dependency injection (testing) ──────────────────────────────────
  /** Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Polling cadence between log fetches (ms). Default 1500. */
  pollIntervalMs?: number;
  /** Per-request timeout (ms). Default 30000. */
  requestTimeoutMs?: number;
  /** Output writer for stdout (`--json` / final result). Defaults to `process.stdout.write`. */
  writeStdout?: (chunk: string) => void;
  /** Output writer for human-facing status lines. Defaults to `process.stderr.write`. */
  writeStderr?: (chunk: string) => void;
  /** File writer for `--output`. Defaults to `node:fs/promises#writeFile`. */
  writeFile?: (path: string, contents: string) => Promise<void>;
}

/**
 * Trigger a remote run and tail it to terminal status.
 *
 * Returns the outcome regardless of success/failure — the caller decides
 * whether to set `process.exitCode`. Throws only on hard failures
 * (network error before the trigger lands, or a non-recoverable HTTP
 * error mid-poll). A run that runs to a `failed` terminal status is a
 * normal return path.
 */
export async function runRemote(
  opts: RunRemoteOptions,
  signal: AbortSignal,
): Promise<RemoteRunOutcome> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const writeStderr = opts.writeStderr ?? ((chunk) => process.stderr.write(chunk));
  const writeStdout = opts.writeStdout ?? ((chunk) => process.stdout.write(chunk));
  const writeFile =
    opts.writeFile ??
    ((path, contents) =>
      import("node:fs/promises").then((m) => m.writeFile(path, contents, "utf8")));

  // ─── 1. Trigger the run ────────────────────────────────────────────
  const runId = await triggerRun(opts, { fetchImpl, requestTimeoutMs });

  if (!opts.json) {
    writeStderr(`→ remote run ${runId} on ${opts.instance}\n`);
  } else {
    writeStdout(
      JSON.stringify({ type: "appstrate.remote.triggered", runId, instance: opts.instance }) + "\n",
    );
  }

  // ─── 2. Cancellation wiring ────────────────────────────────────────
  // Single-shot cancel POST on the first `abort` event. Polling continues
  // until the server flips status to `cancelled` (or any other terminal),
  // so the user always observes the final state before the CLI exits.
  let cancelRequested = false;
  const onAbort = (): void => {
    if (cancelRequested) return;
    cancelRequested = true;
    if (!opts.json) writeStderr(`\nshutdown received, cancelling remote run...\n`);
    void cancelRun(opts, runId, { fetchImpl, requestTimeoutMs }).catch((err: unknown) => {
      if (!opts.json) {
        const msg = err instanceof Error ? err.message : String(err);
        writeStderr(`warn: cancel POST failed: ${msg}\n`);
      }
    });
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  // ─── 3. Poll loop ──────────────────────────────────────────────────
  const seenLogIds = new Set<number>();
  const allLogs: RemoteRunLog[] = [];
  // Run-record polling is cheaper than logs polling — we only refetch
  // it when the last logs poll surfaced no new entries (stalled state).
  // This bounds the call rate at one record fetch per poll tick when
  // idle, plus one per ~10 ticks during active log streaming. The record
  // itself is re-fetched in step 4 to capture the freshest result, so we
  // only use the loop poll for terminal-status detection.
  let recordPollCounter = 0;

  while (true) {
    // Poll logs first — they're the high-frequency stream.
    const logs = await fetchLogs(opts, runId, { fetchImpl, requestTimeoutMs });
    let appended = 0;
    for (const log of logs) {
      if (seenLogIds.has(log.id)) continue;
      seenLogIds.add(log.id);
      allLogs.push(log);
      appended++;
      renderLog(log, opts, { writeStdout, writeStderr });
    }

    // Periodically (or after a quiet tick) refresh the run record so we
    // observe the terminal transition in bounded time.
    const refreshRecord = appended === 0 || recordPollCounter % 10 === 0;
    recordPollCounter++;
    if (refreshRecord) {
      const record = await fetchRunRecord(opts, runId, { fetchImpl, requestTimeoutMs });
      if (TERMINAL_STATUSES.has(record.status)) break;
    }

    // Wait for the next tick — abortable so cancellation kicks in fast.
    await sleepAbortable(pollIntervalMs, signal).catch(() => {
      // Sleep aborts are normal once the user hits Ctrl-C — we still
      // want the next loop iteration to fetch the now-cancelled status.
    });
  }

  // ─── 4. Final fetch — make sure we have the freshest record + tail logs ──
  const finalRecord = await fetchRunRecord(opts, runId, { fetchImpl, requestTimeoutMs });
  const finalLogs = await fetchLogs(opts, runId, { fetchImpl, requestTimeoutMs });
  for (const log of finalLogs) {
    if (seenLogIds.has(log.id)) continue;
    seenLogIds.add(log.id);
    allLogs.push(log);
    renderLog(log, opts, { writeStdout, writeStderr });
  }

  const status = (
    TERMINAL_STATUSES.has(finalRecord.status) ? finalRecord.status : "failed"
  ) as TerminalRunStatus;
  const exitCode = status === "success" ? 0 : 1;

  // ─── 5. Render summary + write --output ────────────────────────────
  renderSummary(finalRecord, status, opts, { writeStdout, writeStderr });

  if (opts.outputPath !== undefined) {
    const payload = {
      runId,
      status,
      result: finalRecord.result ?? null,
      error: finalRecord.error ?? null,
      cost: finalRecord.cost ?? null,
      startedAt: finalRecord.startedAt ?? null,
      completedAt: finalRecord.completedAt ?? null,
    };
    await writeFile(opts.outputPath, JSON.stringify(payload, null, 2));
  }

  return { runId, status, record: finalRecord, logs: allLogs, exitCode };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpDeps {
  fetchImpl: typeof fetch;
  requestTimeoutMs: number;
}

function platformHeaders(opts: RunRemoteOptions, extra: Record<string, string> = {}): Headers {
  const h = new Headers({
    Authorization: `Bearer ${opts.bearerToken}`,
    "X-App-Id": opts.appId,
    Accept: "application/json",
    ...extra,
  });
  if (opts.orgId) h.set("X-Org-Id", opts.orgId);
  return h;
}

async function triggerRun(opts: RunRemoteOptions, deps: HttpDeps): Promise<string> {
  const url = new URL(
    `/api/agents/${encodeURIComponent(opts.scope)}/${encodeURIComponent(opts.name)}/run`,
    opts.instance,
  );
  if (opts.spec) url.searchParams.set("version", opts.spec);

  const body: Record<string, unknown> = {
    input: opts.input,
    config: opts.config,
  };
  if (opts.modelId !== undefined && opts.modelId !== null) body.modelId = opts.modelId;
  if (opts.proxyId !== undefined && opts.proxyId !== null) body.proxyId = opts.proxyId;

  const headers = platformHeaders(opts, { "Content-Type": "application/json" });
  if (opts.idempotencyKey) headers.set("Idempotency-Key", opts.idempotencyKey);

  const res = await timeoutFetch(deps, url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new RemoteRunError(`Trigger failed: ${res.status} ${res.statusText}`, {
      status: res.status,
      body: detail,
      hint:
        res.status === 401 || res.status === 403
          ? "Verify --api-key / `appstrate login` is current and has agents:run permission."
          : res.status === 404
            ? `Agent ${opts.scope}/${opts.name} not found on ${opts.instance}.`
            : undefined,
    });
  }

  const payload = (await res.json().catch(() => null)) as { runId?: unknown } | null;
  const runId = payload && typeof payload.runId === "string" ? payload.runId : null;
  if (!runId) {
    throw new RemoteRunError("Trigger returned no runId", { body: payload });
  }
  return runId;
}

async function fetchRunRecord(
  opts: RunRemoteOptions,
  runId: string,
  deps: HttpDeps,
): Promise<RemoteRunRecord> {
  const url = new URL(`/api/runs/${encodeURIComponent(runId)}`, opts.instance);
  const res = await timeoutFetch(deps, url.toString(), { headers: platformHeaders(opts) });
  if (!res.ok) {
    const detail = await safeReadBody(res);
    throw new RemoteRunError(`GET /api/runs/${runId} failed: ${res.status}`, {
      status: res.status,
      body: detail,
    });
  }
  return (await res.json()) as RemoteRunRecord;
}

async function fetchLogs(
  opts: RunRemoteOptions,
  runId: string,
  deps: HttpDeps,
): Promise<RemoteRunLog[]> {
  const url = new URL(`/api/runs/${encodeURIComponent(runId)}/logs`, opts.instance);
  const res = await timeoutFetch(deps, url.toString(), { headers: platformHeaders(opts) });
  if (!res.ok) {
    // Logs endpoint failures are non-fatal — we keep polling. The next
    // fetchRunRecord will surface the real error if it's persistent.
    return [];
  }
  const payload = (await res.json().catch(() => null)) as RemoteRunLog[] | null;
  return Array.isArray(payload) ? payload : [];
}

async function cancelRun(opts: RunRemoteOptions, runId: string, deps: HttpDeps): Promise<void> {
  const url = new URL(`/api/runs/${encodeURIComponent(runId)}/cancel`, opts.instance);
  const res = await timeoutFetch(deps, url.toString(), {
    method: "POST",
    headers: platformHeaders(opts, { "Content-Type": "application/json" }),
    body: "{}",
  });
  // 409 not_cancellable is fine — the run already terminated by itself.
  if (!res.ok && res.status !== 409) {
    const detail = await safeReadBody(res);
    throw new RemoteRunError(`Cancel failed: ${res.status}`, { status: res.status, body: detail });
  }
}

async function timeoutFetch(deps: HttpDeps, input: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deps.requestTimeoutMs);
  try {
    return await deps.fetchImpl(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadBody(res: Response): Promise<unknown> {
  try {
    const ct = res.headers.get("Content-Type") ?? "";
    if (ct.includes("application/json") || ct.includes("application/problem+json")) {
      return await res.json();
    }
    return await res.text();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface Writers {
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
}

function renderLog(log: RemoteRunLog, opts: RunRemoteOptions, writers: Writers): void {
  if (opts.json) {
    // Spread first so the literal `type` wins over `log.type`.
    writers.writeStdout(
      JSON.stringify({ ...log, type: "appstrate.remote.log", logType: log.type }) + "\n",
    );
    return;
  }
  // Human format — keep it terse, level-prefixed. The dashboard remains
  // the primary surface for verbose introspection; the CLI's job here is
  // to show enough that the user knows the run is alive.
  const prefix =
    log.level === "error" ? "✗" : log.level === "warn" ? "!" : log.level === "info" ? "·" : " ";
  const tag = log.event ? `${log.type}/${log.event}` : log.type;
  const message = log.message?.trim();
  const line = message ? `${prefix} [${tag}] ${message}\n` : `${prefix} [${tag}]\n`;
  writers.writeStderr(line);
}

function renderSummary(
  record: RemoteRunRecord,
  status: TerminalRunStatus,
  opts: RunRemoteOptions,
  writers: Writers,
): void {
  if (opts.json) {
    writers.writeStdout(
      JSON.stringify({
        type: "appstrate.remote.finalize",
        runId: record.id,
        status,
        result: record.result ?? null,
        error: record.error ?? null,
        cost: record.cost ?? null,
        durationMs: record.duration ?? null,
      }) + "\n",
    );
    return;
  }
  const icon = status === "success" ? "✓" : status === "cancelled" ? "·" : "✗";
  const dur = record.duration ? ` in ${formatDurationMs(record.duration)}` : "";
  const cost = record.cost != null ? ` ($${record.cost.toFixed(4)})` : "";
  writers.writeStderr(`${icon} ${status}${dur}${cost}\n`);
  if (status !== "success" && record.error) {
    writers.writeStderr(`  ${record.error}\n`);
  }
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      // Resolve immediately on an already-aborted signal — the caller's
      // next loop iteration runs the terminal-status check.
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
