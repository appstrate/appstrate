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

import type { EventSink } from "@appstrate/afps-runtime/interfaces";
import type { RunEvent } from "@appstrate/afps-runtime/types";
import type { RunResult } from "@appstrate/afps-runtime/runner";
import { createConsoleSink } from "./sink.ts";
import type { Verbosity } from "./format.ts";

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
  /** snake-case to mirror the platform's `runs.tokenUsage` JSONB shape. */
  tokenUsage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
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
   * Tool-call rendering verbosity for the human sink. Mirrors the local
   * `--verbose` / `--quiet` flag wiring so output is byte-identical
   * across local and remote paths. Default `"normal"`.
   */
  verbosity?: Verbosity;
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

  // Match the local path's preamble verbatim so the user sees the same
  // "→ running ... (reporting to ... as run_xxx)" line in both modes.
  // The local path emits this on stderr from runCommandLocal:534 — see
  // also `runCommand.ts` for the source of the format string.
  if (!opts.json) {
    writeStderr(`→ running ${opts.bundleLabel} (reporting to ${opts.instance} as ${runId})\n`);
  } else {
    writeStdout(
      JSON.stringify({ type: "appstrate.remote.triggered", runId, instance: opts.instance }) + "\n",
    );
  }

  // ─── 1b. Set up the local console sink ─────────────────────────────
  //
  // Output parity with the local path is achieved by feeding the *same*
  // sink (createConsoleSink) the canonical RunEvents the platform
  // recorded server-side. Each `run_logs` row is the persisted form of
  // exactly one RunEvent (see `apps/api/src/services/adapters/
  // appstrate-event-sink.ts`); we invert that mapping in
  // `runLogToRunEvent()` and re-dispatch through the sink.
  //
  // JSONL mode delegates entirely to the sink — the runner emits no
  // bespoke `appstrate.remote.*` envelopes anymore (they were a
  // pre-parity artefact). That keeps `--json` output identical to local
  // and unblocks `jq` pipelines that expect canonical events.
  const consoleSink: EventSink = createConsoleSink({
    json: opts.json,
    verbosity: opts.verbosity ?? "normal",
    writeStdout,
  });

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
      const event = runLogToRunEvent(log);
      if (event) await consoleSink.handle(event);
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
    const event = runLogToRunEvent(log);
    if (event) await consoleSink.handle(event);
  }

  const status = (
    TERMINAL_STATUSES.has(finalRecord.status) ? finalRecord.status : "failed"
  ) as TerminalRunStatus;
  const exitCode = status === "success" ? 0 : 1;

  // ─── 5. Synthesize the trailing metric + finalize ──────────────────
  //
  // The platform absorbs `appstrate.metric` events at ingestion time
  // (they update `runs.tokenUsage` + the LLM-usage ledger) without
  // persisting a `run_logs` row, so the inverse mapping cannot recover
  // them. Without this synthesis the user would lose the `∑ tokens
  // in=… out=…  $cost` line at the end of every remote run — a visible
  // local↔remote divergence. We rebuild the equivalent event from the
  // run record's `tokenUsage` + `cost` columns (snake_case JSONB) and
  // dispatch it through the same sink.
  const metricEvent = buildMetricEvent(finalRecord);
  if (metricEvent) await consoleSink.handle(metricEvent);

  // Finalize delegates the `[run complete]` / `[run failed]` line to
  // the local sink, matching local mode byte-for-byte. JSONL mode's
  // `appstrate.finalize` envelope is emitted at the same point in the
  // event stream as local. The `--output` file write is handled below
  // (not via the sink's `outputPath` option) so the runner's `writeFile`
  // DI works for tests without monkeypatching `node:fs/promises`.
  const reconstructedResult = buildRunResultPayload(finalRecord, status);
  await consoleSink.finalize(reconstructedResult);

  if (opts.outputPath !== undefined) {
    await writeFile(opts.outputPath, JSON.stringify(reconstructedResult, null, 2) + "\n");
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

/**
 * Build a URL relative to `opts.instance`. Path is appended verbatim —
 * callers must encode their own runId etc. when needed (we deliberately
 * do NOT encode scope/name here; see `triggerRun` for the rationale).
 */
function apiUrl(opts: RunRemoteOptions, path: string): URL {
  return new URL(path, opts.instance);
}

async function triggerRun(opts: RunRemoteOptions, deps: HttpDeps): Promise<string> {
  // Don't encode scope/name. They're already validated by `package-spec.ts`
  // as `@[a-z0-9-]+/[a-z0-9-]+`, and `encodeURIComponent("@acme")` produces
  // `%40acme` which the server route `:scope{@[^/]+}` rejects as 404 —
  // Hono's RegExpRouter matches against the raw (encoded) path. See the
  // matching comment in `bundle-fetch.ts:buildBundleUrl`.
  const url = apiUrl(opts, `/api/agents/${opts.scope}/${opts.name}/run`);
  if (opts.spec) url.searchParams.set("version", opts.spec);

  const body: Record<string, unknown> = {
    input: opts.input,
    config: opts.config,
  };
  if (opts.modelId != null) body.modelId = opts.modelId;
  if (opts.proxyId != null) body.proxyId = opts.proxyId;

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
  const url = apiUrl(opts, `/api/runs/${encodeURIComponent(runId)}`);
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
  const url = apiUrl(opts, `/api/runs/${encodeURIComponent(runId)}/logs`);
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
  const url = apiUrl(opts, `/api/runs/${encodeURIComponent(runId)}/cancel`);
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
// run_logs row → canonical RunEvent (inverse of appstrate-event-sink.ts)
// ---------------------------------------------------------------------------

/**
 * Reverse the platform's persistence mapping: for each `run_logs` row the
 * platform recorded during a run, return the canonical {@link RunEvent}
 * the runner originally emitted (or `null` for rows that have no event
 * counterpart, like the synthetic `system/run_completed` finalizer or
 * the persisted `result/result` snapshot).
 *
 * The forward mapping lives in
 * `apps/api/src/services/adapters/appstrate-event-sink.ts` —
 * any change there must update this function in lockstep, otherwise
 * `appstrate run` (remote) and `appstrate run --local` will drift
 * apart on rendering.
 *
 * Lossy cases worth knowing:
 *   - `progress/progress` rows can come from either `appstrate.progress`
 *     or `log.written` events; both render the same way through the
 *     console sink (progress branch with optional tool data, log.written
 *     hits the silent default), so we always map to `appstrate.progress`.
 *   - `appstrate.metric` events leave no row — they're synthesized
 *     separately at end-of-run from `runs.tokenUsage` + `runs.cost`.
 *   - `memory.added` / `pinned.set` events are not persisted to
 *     `run_logs` either (they update `package_persistence`); the local
 *     human sink only renders memories with a leading `+ memory:` line,
 *     so the remote-mode user simply doesn't see those breadcrumbs.
 *     Acceptable for v1 — the dashboard surfaces both.
 */
function runLogToRunEvent(log: RemoteRunLog): RunEvent | null {
  // RunEvent envelope requires `timestamp` (Unix ms) + `runId`. We pull
  // them from the row so downstream sinks that index by either field
  // (e.g. CloudEvents adapters) get a stable value rather than a
  // fabricated `Date.now()` snapshot at conversion time.
  const ts = log.createdAt ? Date.parse(log.createdAt) : Date.now();
  const timestamp = Number.isFinite(ts) ? ts : Date.now();
  const envelope = { timestamp, runId: log.runId };

  // `progress/progress` — runner lifecycle breadcrumb or tool call.
  // The console sink's `appstrate.progress` branch handles both cases:
  // when `data.tool` is present it renders the cyan tool-call line +
  // args/result; otherwise it prints the message with a `→` glyph.
  if (log.type === "progress" && log.event === "progress") {
    const data = isPlainObject(log.data) ? (log.data as Record<string, unknown>) : undefined;
    return {
      ...envelope,
      type: "appstrate.progress",
      message: log.message ?? "",
      ...(data ? { data } : {}),
    };
  }

  // `result/output` — `output()` system tool emit. Data is the structured
  // payload (replace-on-emit semantics).
  if (log.type === "result" && log.event === "output") {
    return {
      ...envelope,
      type: "output.emitted",
      data: log.data ?? null,
    };
  }

  // `result/report` — `report(content)` system tool emit. Platform
  // wraps the markdown in `{ content }` to keep the JSONB column
  // structured; we unwrap it here so the canonical event matches the
  // shape the local runner emits.
  if (log.type === "result" && log.event === "report") {
    const content =
      isPlainObject(log.data) && typeof (log.data as { content?: unknown }).content === "string"
        ? (log.data as { content: string }).content
        : null;
    if (content === null) return null;
    return { ...envelope, type: "report.appended", content };
  }

  // `system/adapter_error` — fatal runtime error (e.g. ingestion-side
  // adapter raised an unhandled exception). The local sink renders this
  // with `⚠` yellow on stderr.
  if (log.type === "system" && log.event === "adapter_error") {
    const data = isPlainObject(log.data) ? (log.data as Record<string, unknown>) : undefined;
    return {
      ...envelope,
      type: "appstrate.error",
      message: log.message ?? "adapter error",
      ...(data ? { data } : {}),
    };
  }

  // `result/result` — full RunResult snapshot persisted at finalize. The
  // local sink consumes this via `finalize()` not as an in-stream event,
  // so we drop the row here. The value is still available via the
  // run record's `result` JSONB column.
  // `system/run_completed` — terminal marker used by the dashboard. The
  // local sink's `finalize()` already prints `[run complete] / [run
  // failed]`, so a parallel render here would double-print.
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Synthesize the trailing `appstrate.metric` event from the run record's
 * `tokenUsage` + `cost` columns. The platform absorbs the live
 * `appstrate.metric` events at ingestion time (they update `runs.*`
 * directly without persisting a `run_logs` row), so the inverse mapping
 * above cannot recover them — without this synthesis the user would
 * lose the `∑ tokens in=… out=… $cost` line at the end of every remote
 * run, breaking parity with the local path.
 *
 * Returns `null` when the record carries neither usage nor cost (e.g.
 * a tool-only run with no LLM traffic) so we don't render a misleading
 * `$0.0000` line.
 */
function buildMetricEvent(record: RemoteRunRecord): RunEvent | null {
  const usage = record.tokenUsage ?? null;
  const cost = record.cost ?? null;
  const hasUsage =
    usage != null && ((usage.input_tokens ?? 0) > 0 || (usage.output_tokens ?? 0) > 0);
  if (!hasUsage && cost == null) return null;
  const completedAt = record.completedAt ? Date.parse(record.completedAt) : NaN;
  return {
    type: "appstrate.metric",
    timestamp: Number.isFinite(completedAt) ? completedAt : Date.now(),
    runId: record.id,
    ...(hasUsage ? { usage } : {}),
    ...(cost != null ? { cost } : {}),
    ...(record.duration != null ? { durationMs: record.duration } : {}),
  };
}

/**
 * Reconstruct a {@link RunResult} from the run record + terminal status,
 * matching the shape `EventSink.finalize` consumes locally. Fields the
 * record cannot reconstruct (`memories`, `pinned` named slots,
 * per-event `logs`, `report` aggregate, `usage`) are emitted as empty
 * defaults — the dashboard remains the source of truth for those
 * surfaces. `output` carries `runs.result` (the AFPS `output()` value),
 * matching `RunResult.output`. The status is mapped one-to-one.
 */
function buildRunResultPayload(record: RemoteRunRecord, status: TerminalRunStatus): RunResult {
  const result: RunResult = {
    memories: [],
    pinned: {},
    output: record.result ?? null,
    logs: [],
    status,
  };
  if (record.error) {
    result.error = { code: "remote_run_error", message: record.error };
  }
  if (record.duration != null) result.durationMs = record.duration;
  if (record.cost != null) result.cost = record.cost;
  if (record.tokenUsage) {
    const u = record.tokenUsage;
    result.usage = {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      ...(u.cache_creation_input_tokens != null
        ? { cache_creation_input_tokens: u.cache_creation_input_tokens }
        : {}),
      ...(u.cache_read_input_tokens != null
        ? { cache_read_input_tokens: u.cache_read_input_tokens }
        : {}),
    };
  }
  return result;
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
