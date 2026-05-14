// SPDX-License-Identifier: Apache-2.0

/**
 * Run-scoped per-provider concurrency limiter for `provider_call` MCP
 * tool invocations. Replaces the hand-rolled `Semaphore` class from
 * #429 — `p-queue` provides race-free permit transfer (canonical pattern
 * used by `p-limit`), `pause()` for graceful drain, and `onIdle()` for
 * the in-flight wait — three primitives the custom class lacked.
 *
 * Without a fan-out cap an agent that issues N parallel `provider_call`s
 * funnels N full payloads into the next LLM turn and blows past the
 * upstream model's TPM window (issue #427). Per-provider caps let
 * generous providers (Gmail >>10) run at higher concurrency than rate-
 * sensitive ones (ClickUp throttles fast) without sacrificing safety
 * for everyone.
 *
 * Configured via `SIDECAR_PROVIDER_CALL_CONCURRENCY`, which accepts:
 *
 *   - a plain integer (e.g. `5`) — backwards-compatible with the
 *     legacy single-cap behaviour; applied to every provider.
 *   - a JSON object (e.g. `{"default":3,"@appstrate/gmail":8}`) — a
 *     `default` key plus per-`providerId` overrides.
 *
 * Either form fails loud at boot on malformed input.
 */

import PQueue from "p-queue";
import { logger } from "./logger.ts";

/**
 * Default cap on simultaneous `provider_call` MCP invocations per
 * provider. Three matches the typical browsing concurrency a single
 * LLM turn can usefully exploit while leaving headroom under most
 * providers' per-IP rate limits. Operators can override via
 * `SIDECAR_PROVIDER_CALL_CONCURRENCY`.
 */
export const DEFAULT_PROVIDER_CALL_CONCURRENCY = 3;

/** Reserved key in the JSON form that sets the fallback cap. */
export const DEFAULT_CONCURRENCY_KEY = "default";

/**
 * Default queue-depth alert threshold. When any provider's parked
 * waiters exceed this for {@link DEFAULT_QUEUE_DEPTH_DWELL_MS} the
 * registry emits one `appstrate.error` log line. Sized so that normal
 * burst traffic (a handful of parallel tool calls clearing in a few
 * hundred ms) never trips the alert, but a runaway agent fanning out
 * dozens of calls without consuming them surfaces visibly before the
 * run times out.
 */
export const DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD = 10;
export const DEFAULT_QUEUE_DEPTH_DWELL_MS = 30_000;
export const DEFAULT_QUEUE_DEPTH_POLL_MS = 5_000;

/**
 * Resolved concurrency configuration. `default` covers every providerId
 * not present in `perProvider`. Both must be positive integers — the
 * parser fails loud on anything else.
 */
export interface ConcurrencyConfig {
  default: number;
  perProvider: Map<string, number>;
}

/**
 * Per-provider queue-depth watcher knobs. All three are injectable so
 * tests can drive the alert in millisecond wall-clock time without
 * real sleeps.
 */
export interface LimiterRegistryOptions {
  /** Queue depth above which the dwell timer arms. */
  queueDepthAlertThreshold?: number;
  /** How long depth must stay above the threshold before alerting. */
  queueDepthDwellMs?: number;
  /** Poll interval. Should be <= dwell / 2. */
  queueDepthPollMs?: number;
}

/**
 * Parse the `SIDECAR_PROVIDER_CALL_CONCURRENCY` env value. Two forms:
 *
 *   - plain integer: applied as the `default` cap, no overrides.
 *   - JSON object: `{ default?, [providerId]: int, ... }`. Missing
 *     `default` falls back to {@link DEFAULT_PROVIDER_CALL_CONCURRENCY}.
 *
 * Returns the default config when `raw` is `undefined`/`""`. Throws on
 * any malformed value so misconfiguration is caught at sidecar boot.
 */
export function parseConcurrencyConfig(raw: string | undefined): ConcurrencyConfig {
  if (raw === undefined || raw === "") {
    return { default: DEFAULT_PROVIDER_CALL_CONCURRENCY, perProvider: new Map() };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `SIDECAR_PROVIDER_CALL_CONCURRENCY: invalid JSON (${(err as Error).message}). ` +
          `Expected a positive integer or {"default":N, "<providerId>":N, ...}.`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `SIDECAR_PROVIDER_CALL_CONCURRENCY: JSON value must be an object, got ${JSON.stringify(parsed)}.`,
      );
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const perProvider = new Map<string, number>();
    let defaultValue = DEFAULT_PROVIDER_CALL_CONCURRENCY;
    for (const [key, value] of entries) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0
      ) {
        throw new Error(
          `SIDECAR_PROVIDER_CALL_CONCURRENCY: value for ${JSON.stringify(key)} must be a positive integer, got ${JSON.stringify(value)}.`,
        );
      }
      if (key === DEFAULT_CONCURRENCY_KEY) {
        defaultValue = value;
      } else {
        perProvider.set(key, value);
      }
    }
    return { default: defaultValue, perProvider };
  }
  const parsedInt = Number(trimmed);
  if (!Number.isFinite(parsedInt) || !Number.isInteger(parsedInt) || parsedInt <= 0) {
    throw new Error(
      `SIDECAR_PROVIDER_CALL_CONCURRENCY must be a positive integer or a JSON object, got ${JSON.stringify(raw)}.`,
    );
  }
  return { default: parsedInt, perProvider: new Map() };
}

/**
 * Snapshot of a per-provider limiter's runtime state. Returned by
 * {@link LimiterRegistry.snapshot} so tests and the queue-depth
 * watcher can inspect each lane without poking at p-queue internals.
 */
export interface LimiterSnapshot {
  providerId: string;
  concurrency: number;
  pending: number;
  active: number;
}

/**
 * Per-provider limiter registry backed by `p-queue`. The registry is
 * lazy: a `PQueue` is created the first time a provider is seen, with
 * concurrency drawn from {@link ConcurrencyConfig}.
 *
 * Lifecycle:
 *
 *   - `run(providerId, fn)` enqueues `fn` and returns its resolved value.
 *     Backpressure: if `concurrency` is already saturated the underlying
 *     queue parks `fn` in FIFO order and dequeues on the next completion.
 *     `p-queue` transfers the permit synchronously to the next waiter,
 *     closing the #430 race window.
 *   - `pause()` flips a registry-wide flag — subsequent `run()` calls
 *     reject with {@link DrainingError}, but already-queued items run to
 *     completion. Used by the SIGTERM handler.
 *   - `onIdle(timeoutMs)` waits for every queue to drain, capped at
 *     `timeoutMs`. Returns whether the wait completed cleanly.
 *   - `dispose()` stops the queue-depth watcher (used in tests / shutdown).
 */
export class DrainingError extends Error {
  constructor() {
    super("sidecar draining");
    this.name = "DrainingError";
  }
}

export interface QueueDepthAlertSink {
  (line: { providerId: string; depth: number; dwellMs: number }): void;
}

export class LimiterRegistry {
  readonly config: ConcurrencyConfig;
  private readonly queues = new Map<string, PQueue>();
  private draining = false;
  private readonly pollMs: number;
  private readonly dwellMs: number;
  private readonly threshold: number;
  private readonly armedSince = new Map<string, number>();
  private readonly alerted = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly alertSink: QueueDepthAlertSink;
  // Injectable clock — defaults to wall-clock. Tests pass a controllable
  // function so they can advance "time" without real sleeps.
  private readonly now: () => number;

  constructor(
    config: ConcurrencyConfig,
    options: LimiterRegistryOptions & {
      alertSink?: QueueDepthAlertSink;
      now?: () => number;
    } = {},
  ) {
    this.config = config;
    this.threshold = options.queueDepthAlertThreshold ?? DEFAULT_QUEUE_DEPTH_ALERT_THRESHOLD;
    this.dwellMs = options.queueDepthDwellMs ?? DEFAULT_QUEUE_DEPTH_DWELL_MS;
    this.pollMs = options.queueDepthPollMs ?? DEFAULT_QUEUE_DEPTH_POLL_MS;
    this.now = options.now ?? (() => Date.now());
    this.alertSink =
      options.alertSink ??
      ((line) => {
        logger.error("appstrate.error", {
          kind: "sidecar.provider_call.queue_depth",
          providerId: line.providerId,
          depth: line.depth,
          dwellMs: line.dwellMs,
        });
      });
  }

  /** Concurrency that applies to the given provider. */
  private concurrencyFor(providerId: string): number {
    return this.config.perProvider.get(providerId) ?? this.config.default;
  }

  private getQueue(providerId: string): PQueue {
    let queue = this.queues.get(providerId);
    if (!queue) {
      queue = new PQueue({ concurrency: this.concurrencyFor(providerId) });
      this.queues.set(providerId, queue);
    }
    return queue;
  }

  /** Runtime snapshot — one entry per provider that has issued a call. */
  snapshot(): LimiterSnapshot[] {
    const out: LimiterSnapshot[] = [];
    for (const [providerId, queue] of this.queues) {
      out.push({
        providerId,
        concurrency: queue.concurrency,
        pending: queue.size,
        active: queue.pending,
      });
    }
    return out;
  }

  /** True after {@link pause} has been called. */
  isDraining(): boolean {
    return this.draining;
  }

  /**
   * Enqueue `fn` onto the providerId's queue. If the registry is
   * draining, rejects with {@link DrainingError} without invoking `fn`.
   *
   * The `p-queue.add(fn)` return is typed as `T | void` because the
   * library supports an `AbortSignal`-driven cancel. We don't pass a
   * signal, so the function always runs to completion — the cast back
   * to `T` is safe.
   */
  async run<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    if (this.draining) throw new DrainingError();
    const queue = this.getQueue(providerId);
    return (await queue.add(fn, { throwOnTimeout: true })) as T;
  }

  /**
   * Flip the registry into drain mode. Already-queued items continue
   * running; new {@link run} calls reject. `p-queue.pause()` would also
   * halt in-flight dequeueing — we don't want that here, we want the
   * existing backlog to flush so the run finishes cleanly.
   */
  pause(): void {
    this.draining = true;
  }

  /**
   * Wait until every queue is idle (pending + active == 0), capped at
   * `timeoutMs`. Returns `true` if drained cleanly, `false` on timeout.
   * Safe to call multiple times.
   */
  async onIdle(timeoutMs: number): Promise<boolean> {
    const all = Promise.all([...this.queues.values()].map((q) => q.onIdle()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const result = await Promise.race([all.then(() => "idle" as const), timeout]);
      return result === "idle";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Start the queue-depth watcher. Polls every {@link pollMs} ms; when
   * any provider's `pending` exceeds {@link threshold} for more than
   * {@link dwellMs} ms, emits one `appstrate.error` log line. The
   * dwell timer re-arms only after depth drops back below the threshold
   * so a steady overload produces one alert per crossing, not a stream.
   */
  startQueueDepthWatcher(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => this.checkQueueDepth(), this.pollMs);
    // In Bun, `Timer.unref()` lets the process exit even while the
    // watcher is armed — production never relies on this (the SIGTERM
    // path stops it explicitly), but tests that import the registry
    // shouldn't have their process kept alive by a stray poll loop.
    const t = this.pollTimer as unknown as { unref?: () => void };
    t.unref?.();
  }

  /**
   * Run the queue-depth check once. Public so tests can drive it on a
   * controlled clock instead of waiting for the real interval.
   */
  checkQueueDepth(): void {
    const now = this.now();
    for (const [providerId, queue] of this.queues) {
      const depth = queue.size;
      if (depth > this.threshold) {
        const armedAt = this.armedSince.get(providerId);
        if (armedAt === undefined) {
          this.armedSince.set(providerId, now);
        } else if (!this.alerted.has(providerId) && now - armedAt >= this.dwellMs) {
          this.alerted.add(providerId);
          this.alertSink({ providerId, depth, dwellMs: now - armedAt });
        }
      } else {
        this.armedSince.delete(providerId);
        this.alerted.delete(providerId);
      }
    }
  }

  /** Stop the queue-depth watcher. Idempotent. */
  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

/**
 * Default ceiling on the graceful-shutdown wait (#435). Set well under
 * the run-tracker's 300 s grace window so an already-stuck upstream
 * hop can't keep the sidecar alive past the run boundary.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Drain a limiter registry and then invoke `exit(code)`.
 *
 *   - `signal` is the trigger label ("SIGTERM", "SIGINT", …) emitted
 *     into the structured logs.
 *   - `timeoutMs` caps the wait on in-flight work. When the wait
 *     completes cleanly the process exits 0; on timeout it exits 1
 *     so external orchestrators can distinguish a graceful drain
 *     from a forced kill.
 *   - `exit` is injectable so tests can assert the exit code without
 *     calling `process.exit`. Production wires this to
 *     `process.exit` in `server.ts`.
 *
 * Idempotent: a second call while a drain is already in flight is
 * a no-op. The caller owns reentrancy by handing in a fresh `state`
 * object — production stores the flag at module scope in
 * `server.ts` so SIGTERM + SIGINT race cleanly.
 */
export async function drainRegistry(
  registry: LimiterRegistry,
  signal: string,
  opts: {
    timeoutMs?: number;
    onStart?: (entry: { signal: string; timeoutMs: number }) => void;
    onComplete?: (entry: { signal: string; idle: boolean; elapsedMs: number }) => void;
    exit?: (code: number) => void;
  } = {},
): Promise<{ idle: boolean; elapsedMs: number }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  opts.onStart?.({ signal, timeoutMs });
  const startedAt = Date.now();
  registry.pause();
  const idle = await registry.onIdle(timeoutMs);
  registry.dispose();
  const elapsedMs = Date.now() - startedAt;
  opts.onComplete?.({ signal, idle, elapsedMs });
  opts.exit?.(idle ? 0 : 1);
  return { idle, elapsedMs };
}
