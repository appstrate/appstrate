// SPDX-License-Identifier: Apache-2.0

/**
 * Runner-side liveness keep-alive.
 *
 * Posts to `POST /api/runs/:runId/events/heartbeat` on a jittered
 * interval using the same Standard-Webhooks HMAC auth as event
 * ingestion — so platform containers (runSecret only, no user
 * principal) and remote CLIs share a single implementation. The server
 * bumps `runs.last_heartbeat_at`; the stall watchdog reads that column
 * to decide if a runner has died.
 *
 * Shape contract with the watchdog (see
 * `apps/api/src/services/run-watchdog.ts`):
 *   - The heartbeat is a proof-of-life only — no payload, no sequence
 *     number, no log row. Any authenticated event POST bumps the same
 *     column, so the heartbeat exists purely to cover idle periods.
 *   - Heartbeat failures are non-fatal: we log-and-swallow because a
 *     transient network error shouldn't tear down an otherwise healthy
 *     run. The watchdog is the backstop — if heartbeats have truly
 *     stopped, it finalizes as `failed` after `stallThreshold`.
 *   - Every attempt is deadline-bounded (see `attemptTimeoutMs` below).
 *     Ticks are serialised, so an unbounded POST that never settles is not
 *     one lost ping — it silences the heartbeat for the rest of the run and
 *     makes the watchdog reap a live container.
 *
 * Jitter (±15% by default): per the AWS Builders' Library "timeouts,
 * retries, backoff with jitter" guidance, randomising the interval
 * prevents a herd of runners from hammering the heartbeat endpoint in
 * lockstep after a shared network blip.
 */

import { sign } from "@appstrate/afps-runtime/events";

export interface StartSinkHeartbeatOptions {
  /**
   * Full heartbeat URL. Typically `<sink-url>/heartbeat` where
   * `<sink-url>` is the base events URL returned by run creation.
   */
  readonly url: string;
  /** Raw run secret used by HttpSink. The only cross-call shared secret. */
  readonly runSecret: string;
  /** Interval in milliseconds (default 15_000 — 15s, matches `RUN_HEARTBEAT_INTERVAL_SECONDS`). */
  readonly intervalMs?: number;
  /** Jitter fraction applied symmetrically (default 0.15 — ±15%). */
  readonly jitter?: number;
  /** Low-level HTTP client (testing). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Time source (testing). Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Event-id generator (testing). Defaults to `crypto.randomUUID`. */
  readonly generateId?: () => string;
  /**
   * Optional error sink — invoked instead of the default JSON-line
   * stderr writer so the host application can route heartbeat
   * failures through its own logger (e.g. pino in the platform API).
   * Must never throw.
   *
   * The default emits a structured JSON line so platform consumers
   * that scrape stderr (Docker / Coolify / pino) get parseable
   * output without runner-pi taking a logger dependency.
   */
  readonly onError?: (err: unknown) => void;
}

function defaultErrorSink(err: unknown): void {
  const line = {
    level: "error" as const,
    time: Date.now(),
    component: "sink-heartbeat",
    msg: err instanceof Error ? err.message : String(err),
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
  };
  // stderr write — JSON line, pino-compatible enough that downstream
  // platform consumers parse it without special-casing.
  try {
    process.stderr.write(`${JSON.stringify(line)}\n`);
  } catch {
    // Last-resort fallback when the raw stderr write throws (closed pipe,
    // detached fd). This is the ONE sanctioned `console.*` in the repo, and it
    // is sanctioned precisely because it is the fallback FOR the write the ban
    // points at: `console.error` swallows its own write failures by contract,
    // so it cannot throw a second time out of an error path.
    // eslint-disable-next-line no-console
    console.error("[sink-heartbeat]", err);
  }
}

export interface SinkHeartbeatHandle {
  /** Stop the loop. Idempotent and synchronous. */
  stop(): void;
}

/**
 * Start a periodic HMAC-signed heartbeat POST. Returns a handle whose
 * `stop()` cancels the loop. Safe to call during runner bootstrap —
 * the first heartbeat fires after `intervalMs`, not immediately, so a
 * sub-heartbeat-interval run completes cleanly without ever pinging.
 */
export function startSinkHeartbeat(opts: StartSinkHeartbeatOptions): SinkHeartbeatHandle {
  const intervalMs = opts.intervalMs ?? 15_000;
  const jitter = opts.jitter ?? 0.15;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const onError = opts.onError ?? defaultErrorSink;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The controller of the POST currently in flight, if any (see `stop()`). */
  let inFlight: AbortController | null = null;

  /**
   * Per-attempt deadline, derived from the tick interval rather than added as
   * a separate knob: half an interval.
   *
   * Ticks are serialised (`sendOnce().finally(scheduleNext)`), so an attempt
   * that never settles does not merely lose one ping — it stops the loop for
   * good, and the platform's stall watchdog then reaps a container that is
   * perfectly alive. That is the exact failure this component exists to
   * prevent, so every attempt must be bounded.
   *
   * Half an interval, and not more. The invariant to preserve is that a hung
   * attempt must still leave a ping inside the watchdog's window. Worst case is
   * a hang (half an interval) followed by the LONGEST jittered wait, not by a
   * plain interval: `scheduleNext` multiplies the interval by
   * `1 + jitter` at the top of its range, so the next tick is 1.15 intervals
   * away at the 0.15 default. The gap between two ATTEMPTS is therefore capped
   * at 1.65 intervals — 24.75 s at this helper's 15 s default (the CLI) and
   * 49.5 s at the container's `HEARTBEAT_INTERVAL_MS` of 30 s. Both are under
   * the 60 s `RUN_STALL_THRESHOLD_SECONDS` the platform reaps on, the tighter
   * of the two by 10.5 s. A deadline at or above the interval pushes that gap
   * to ≥2.15 intervals, which at 30 s is 64.5 s and exceeds the threshold
   * outright: the pile-up again, only slower. In the other direction, even the
   * smaller 7.5 s is orders of magnitude above an honest heartbeat RTT (a
   * bodyless POST to the platform), so it cannot fire on a merely
   * slow-but-live network.
   */
  const attemptTimeoutMs = Math.max(1, Math.round(intervalMs / 2));

  const scheduleNext = (): void => {
    if (stopped) return;
    const jitterFactor = 1 + (Math.random() - 0.5) * 2 * jitter;
    const delayMs = Math.max(1, Math.round(intervalMs * jitterFactor));
    timer = setTimeout(() => {
      void sendOnce().finally(scheduleNext);
    }, delayMs);
  };

  const sendOnce = async (): Promise<void> => {
    if (stopped) return;
    // Minimal JSON body (not empty). undici and some `fetch`
    // implementations strip a truly empty body on POST, which breaks
    // HMAC verification (client signs "", server reads the stripped
    // body as "" but the Content-Length: 0 / transfer encoding may
    // present the payload differently). `{}` keeps the bytes stable
    // across transports. The server's handler ignores the payload.
    const body = "{}";
    const msgId = generateId();
    const timestampSec = Math.floor(now() / 1000);
    const headers = sign({ msgId, timestampSec, body, secret: opts.runSecret });
    // Two ways this request may be cut short, composed into one signal:
    // `attempt` is `stop()`'s handle on an in-flight POST, the timeout is the
    // per-tick deadline above. Nothing reads the response body, so a
    // whole-request bound is the right instrument here (unlike a streaming
    // upstream, where it would also cap the stream).
    const attempt = new AbortController();
    inFlight = attempt;
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(attemptTimeoutMs)]),
      });
      if (!res.ok && res.status !== 410) {
        // 410 (Gone) — sink already closed, equivalent to "stop" from
        // the server's point of view. Any other 4xx/5xx is a real
        // failure worth surfacing.
        onError(new Error(`heartbeat failed: ${res.status} ${res.statusText}`));
      }
      if (res.status === 410) {
        // Server has closed the sink — no point in pinging further.
        stopped = true;
      }
    } catch (err) {
      // A rejection caused by our own `stop()` is not a fault to report: the
      // caller asked for the abort and is already tearing the run down.
      if (!stopped) onError(err);
    } finally {
      inFlight = null;
    }
  };

  scheduleNext();

  return {
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Clearing the timer cancels the NEXT tick; it says nothing about a POST
      // already in flight, which would otherwise hold a socket until its
      // deadline expires — past the run's own teardown. Abort it explicitly so
      // `stop()` means stopped.
      inFlight?.abort();
      inFlight = null;
    },
  };
}
