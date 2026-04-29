// SPDX-License-Identifier: Apache-2.0

/**
 * `runRemote` — remote execution path for `appstrate run`.
 *
 * Trigger: `POST /api/agents/:scope/:name/run` returns `{ runId }` and
 * the platform spawns a Pi container (same path as the dashboard "Run"
 * button). The CLI then tails the run by polling two endpoints:
 *
 *   - `GET /api/runs/:runId/logs?since=<lastId>` — append-only run-log
 *     entries with `id > since`. The cursor is required for bounded
 *     per-poll cost: without it the server returns the run's full
 *     history every tick and per-poll wire size grows linearly with run
 *     length. We track the highest log id we've rendered and pass it as
 *     `?since=` on the next request.
 *   - `GET /api/runs/:runId` — terminal-status detection + the final
 *     RunResult/error/cost reconciliation.
 *
 * Polling (rather than SSE) is the v1 transport because the realtime
 * endpoint's `validateSSEAuth` (apps/api/src/routes/realtime.ts) only
 * accepts API-key tokens and cookie sessions — interactive CLI auth
 * uses Bearer JWTs, which the standard auth pipeline accepts on
 * `/api/runs/...` but not on the SSE handler. Polling sidesteps this
 * cleanly without any server change. Migrating to SSE later is a pure
 * client-side swap behind the same `runRemote()` entry point.
 *
 * Record-poll cadence is throttle-driven, not log-activity-driven: a
 * fixed `recordPollEveryNTicks` (default every 4 ticks ≈ 6s) refreshes
 * the run record so terminal-status detection happens in bounded time
 * regardless of whether the run is streaming logs or sitting idle. The
 * loop also forces a record fetch on the first iteration so very short
 * runs (success in <1 tick) finalize without a wasted log-poll.
 *
 * Cancellation: on `signal` abort the runner POSTs `/api/runs/:id/cancel`
 * once and continues polling until the run reaches a terminal status.
 * Idempotency-Key on the trigger POST guards against accidental double
 * submission across CLI retries.
 */

const TERMINAL_STATUSES = new Set(["success", "failed", "timeout", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECORD_POLL_EVERY_N_TICKS = 4;

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
  /**
   * Optional path — final RunResult JSON written here. Shape parity
   * with the local path's `--output`: top-level keys match the AFPS
   * `RunResult` (`memories`, `pinned`, `output`, `logs`, `error`,
   * `status`, `durationMs`, `cost`). `memories`, `pinned`, `logs`, and
   * `report` are emitted as empty defaults — the remote path does not
   * have a server-side endpoint surfacing the runner's reduced AFPS
   * state, only `runs.result`. Two remote-only extras (`runId`,
   * `instance`) are added for debuggability.
   */
  outputPath?: string | undefined;
  /** Label printed on the "→ running …" stderr line. */
  bundleLabel: string;

  // ─── Dependency injection (testing) ──────────────────────────────────
  /** Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Polling cadence between log fetches (ms). Default 1500. */
  pollIntervalMs?: number;
  /**
   * How often (in poll ticks) to refetch the run record for terminal-
   * status detection. Decoupled from log activity — an idle run that
   * emits no logs still terminates within `recordPollEveryNTicks *
   * pollIntervalMs` of the server flipping status. Default 4 ticks.
   */
  recordPollEveryNTicks?: number;
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
  const recordPollEveryNTicks = opts.recordPollEveryNTicks ?? DEFAULT_RECORD_POLL_EVERY_N_TICKS;
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
  //
  // Two cadences run in lockstep:
  //
  // - Logs polled every tick with `?since=<lastLogId>` so the wire payload
  //   is bounded by what's new since the last poll, not by total run length.
  // - Run record refreshed every `recordPollEveryNTicks` ticks regardless
  //   of log activity, plus once on tick 0 so very short runs (<1 tick)
  //   finalize without an extra wait. Decoupling the record fetch from log
  //   activity prevents the previous behaviour where idle runs (waiting
  //   on an LLM) refetched the record every tick.
  //
  // `seenLogIds` is retained as a defense-in-depth dedup against race
  //  conditions on the cursor (e.g. server clock skew, retry duplicating a
  //  row) — under normal conditions `?since=` already returns each row
  //  exactly once.
  const seenLogIds = new Set<number>();
  const allLogs: RemoteRunLog[] = [];
  let lastLogId = 0;
  let tick = 0;

  while (true) {
    // Logs first — high-frequency, bounded by the cursor.
    const logs = await fetchLogs(opts, runId, lastLogId, { fetchImpl, requestTimeoutMs });
    for (const log of logs) {
      if (seenLogIds.has(log.id)) continue;
      seenLogIds.add(log.id);
      allLogs.push(log);
      if (log.id > lastLogId) lastLogId = log.id;
      renderLog(log, opts, { writeStdout, writeStderr });
    }

    // Record poll runs on a fixed cadence (tick 0, then every N ticks).
    // Independent of `appended` so an idle agent terminates in bounded
    // time without an unrelated stream of polls.
    if (tick % recordPollEveryNTicks === 0) {
      const record = await fetchRunRecord(opts, runId, { fetchImpl, requestTimeoutMs });
      if (TERMINAL_STATUSES.has(record.status)) break;
    }
    tick++;

    // Wait for the next tick — abortable so cancellation kicks in fast.
    await sleepAbortable(pollIntervalMs, signal).catch(() => {
      // Sleep aborts are normal once the user hits Ctrl-C — we still
      // want the next loop iteration to fetch the now-cancelled status.
    });
  }

  // ─── 4. Final fetch — make sure we have the freshest record + tail logs ──
  //
  // The server flips status + closes the sink atomically (any in-flight
  // event POST 410's after that point), so by the time the loop observes
  // a terminal status all log rows for this run are already persisted.
  // We still re-fetch logs once with `?since=lastLogId` to pick up any
  // rows committed in the same transaction as the status flip, in case
  // they landed after our last loop poll but before the loop's record
  // fetch saw the terminal state.
  const finalRecord = await fetchRunRecord(opts, runId, { fetchImpl, requestTimeoutMs });
  const finalLogs = await fetchLogs(opts, runId, lastLogId, { fetchImpl, requestTimeoutMs });
  for (const log of finalLogs) {
    if (seenLogIds.has(log.id)) continue;
    seenLogIds.add(log.id);
    allLogs.push(log);
    if (log.id > lastLogId) lastLogId = log.id;
    renderLog(log, opts, { writeStdout, writeStderr });
  }

  const status = (
    TERMINAL_STATUSES.has(finalRecord.status) ? finalRecord.status : "failed"
  ) as TerminalRunStatus;
  const exitCode = status === "success" ? 0 : 1;

  // ─── 5. Render summary + write --output ────────────────────────────
  renderSummary(finalRecord, status, opts, { writeStdout, writeStderr });

  if (opts.outputPath !== undefined) {
    // Shape parity with the local path's `--output`: the local
    // EventSink writes a full `RunResult` (memories, pinned, output,
    // logs, error, status, durationMs, usage, cost, report). The remote
    // path doesn't have an event-stream reducer of its own — the
    // platform aggregated the events server-side — so we reconstruct as
    // much of the same surface as the run record exposes. Fields that
    // would require additional endpoints (memories, pinned named slots,
    // report, runner-source token usage) are emitted as empty defaults
    // so consumers can rely on the top-level keys being present.
    //
    // Two remote-only extras (`runId`, `instance`) are added on top —
    // they are useful for debugging and do not collide with any
    // RunResult field.
    const payload = buildRunResultPayload(runId, opts.instance, finalRecord, status);
    await writeFile(opts.outputPath, JSON.stringify(payload, null, 2) + "\n");
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

  // The server's contract is `{ runId: string }` (apps/api/src/routes/runs.ts
  // → `c.json({ runId })`). We accept *only* that shape — falling back to
  // alternate keys (`{ id }`, `{ run.id }`, …) would silently mask a
  // contract drift instead of failing fast at the boundary. The error
  // body carries the unexpected payload so the user can debug a server
  // mismatch without re-running with extra logging.
  const payload = (await res.json().catch(() => null)) as { runId?: unknown } | null;
  if (!payload || typeof payload !== "object") {
    throw new RemoteRunError("Trigger returned a non-JSON response", {
      body: payload,
      hint: "The server should return `{ runId: string }`. Check the platform version on the pinned instance.",
    });
  }
  if (typeof payload.runId !== "string" || payload.runId.length === 0) {
    throw new RemoteRunError("Trigger response missing `runId` string", {
      body: payload,
      hint: "Expected `{ runId: string }`. The platform may be incompatible with this CLI version.",
    });
  }
  return payload.runId;
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
  sinceId: number,
  deps: HttpDeps,
): Promise<RemoteRunLog[]> {
  const url = new URL(`/api/runs/${encodeURIComponent(runId)}/logs`, opts.instance);
  // `since=0` is treated as "no cursor" by the server (rows have id ≥ 1),
  // so we send it unconditionally — keeps the URL shape uniform across
  // the first poll and the subsequent ones for easier debugging.
  if (sinceId > 0) url.searchParams.set("since", String(sinceId));
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

/**
 * Build the `--output` JSON payload for a remote run, shaped to match
 * the local path's `RunResult` surface (see
 * `packages/afps-runtime/src/types/run-result.ts`). Fields the run
 * record does not expose — `memories`, `pinned`, `logs`, `report`,
 * `usage` — are emitted as empty defaults so downstream consumers can
 * rely on the top-level key set being identical between local and
 * remote `--output` files. `runId` and `instance` are remote-only
 * extras for debuggability.
 */
function buildRunResultPayload(
  runId: string,
  instance: string,
  record: RemoteRunRecord,
  status: TerminalRunStatus,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId,
    instance,
    status,
    output: record.result ?? null,
    memories: [],
    pinned: {},
    logs: [],
  };
  if (record.error) {
    payload.error = { message: record.error };
  }
  if (record.duration != null) payload.durationMs = record.duration;
  if (record.cost != null) payload.cost = record.cost;
  return payload;
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
