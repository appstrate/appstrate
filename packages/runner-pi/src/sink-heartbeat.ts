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
  /** Interval in milliseconds (default 30_000 — 30s). */
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
   * Optional error sink — invoked instead of `console.error` so the
   * host application can route heartbeat failures through its own
   * logger. Must never throw.
   */
  readonly onError?: (err: unknown) => void;
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
  const intervalMs = opts.intervalMs ?? 30_000;
  const jitter = opts.jitter ?? 0.15;
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const generateId = opts.generateId ?? (() => crypto.randomUUID());
  const onError = opts.onError ?? ((err) => console.error("[sink-heartbeat]", err));

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

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
    try {
      const res = await fetchImpl(opts.url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body,
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
      onError(err);
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
    },
  };
}
