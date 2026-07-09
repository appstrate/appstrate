// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime-event drainer — the consumer half of the sidecar runtime-event
 * journal (see `runtime-pi/sidecar/runtime-event-journal.ts`).
 *
 * The sidecar executes each runtime tool's handler ONCE and journals the
 * authoritative canonical events (`log.written`, `memory.added`, …) in an
 * in-memory per-run FIFO. The Pi runner DRAINS that journal over HTTP at its
 * step boundaries and re-emits each event on its single run-event sink —
 * preserving the single-writer contiguous sequence. One execution,
 * transport-agnostic, no dependence on the MCP transport preserving result
 * `_meta`.
 *
 * The drainer NEVER throws and NEVER fails a run: a network hiccup mid-stream
 * is retried on the next drain; an unreachable journal at finalize is logged
 * loud (`runtime_events_incomplete`) and tolerated. The structured `output` is
 * re-validated at finalize (a lost `output` therefore fails the run there, not
 * silently); `log`/`report` are cosmetic. `note`/`pin` (`memory.added`/
 * `pinned.set`) persist across runs and are NOT re-derivable, so the final
 * drain's bounded retry is their compensating control — but still best-effort:
 * dropping a whole run over one undrained event would be disproportionate.
 */

import type { RuntimeToolEvent } from "./runtime-tool-defs.ts";

/** Minimal structured logger shape (matches both the sidecar logger and `@appstrate/core/logger`). */
export interface DrainLogger {
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
}

const NOOP_LOGGER: DrainLogger = { warn: () => {}, error: () => {} };

export interface RuntimeEventDrainerOptions {
  /** Absolute URL of the sidecar `GET /runtime-events` endpoint. */
  url: string;
  /** Headers sent with every drain request (e.g. `{ Host: "sidecar" }`). */
  headers?: Record<string, string>;
  /** Injected logger; defaults to a no-op (the drainer is silent in tests). */
  logger?: DrainLogger;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface DrainOptions {
  /**
   * Final drain before finalize: loop until the journal is empty + retry a
   * bounded number of times on failure (the sidecar is torn down right after
   * the run, so the last tool's events must be pulled now or never).
   */
  final?: boolean;
}

/** Wire shape returned by the sidecar `GET /runtime-events` endpoint. */
interface DrainResponse {
  events: RuntimeToolEvent[];
  cursor: number;
  /** Smallest sequence still in the journal — lets the drainer detect FIFO eviction. */
  firstSeq?: number;
}

export interface RuntimeEventDrainer {
  /**
   * Pull every event appended since the last drain, advance the cursor, and
   * return the new events (WITHOUT `runId` — the caller stamps it when emitting
   * on the run's sink). Returns `[]` on a transient failure (intermediate mode)
   * or after exhausting retries (final mode).
   */
  drain(opts?: DrainOptions): Promise<RuntimeToolEvent[]>;
}

const FINAL_RETRY_ATTEMPTS = 3;
const FINAL_RETRY_BASE_MS = 50;
const REQUEST_TIMEOUT_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRuntimeEventDrainer(
  options: RuntimeEventDrainerOptions,
): RuntimeEventDrainer {
  const log = options.logger ?? NOOP_LOGGER;
  const doFetch = options.fetch ?? fetch;
  // Monotonic in-memory cursor: the highest sequence this drainer has consumed.
  // Starts at 0 (the journal assigns seq >= 1), so the first drain pulls all.
  let cursor = 0;

  /** One HTTP round-trip. Returns the parsed batch or `null` on any failure. */
  async function fetchBatch(): Promise<DrainResponse | null> {
    try {
      const sep = options.url.includes("?") ? "&" : "?";
      const res = await doFetch(`${options.url}${sep}after=${cursor}`, {
        headers: options.headers ?? {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn("runtime_events_drain_http_error", { status: res.status });
        return null;
      }
      const body = (await res.json()) as DrainResponse;
      if (!body || !Array.isArray(body.events) || typeof body.cursor !== "number") {
        log.warn("runtime_events_drain_bad_body", {});
        return null;
      }
      return body;
    } catch (err) {
      log.warn("runtime_events_drain_fetch_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Apply a batch: detect truncation, advance the cursor, return its events. */
  function consume(batch: DrainResponse): RuntimeToolEvent[] {
    // FIFO eviction: the oldest sequence still in the journal is past our
    // cursor → events were dropped before we could pull them. Loud, not silent.
    if (typeof batch.firstSeq === "number" && batch.firstSeq > cursor + 1) {
      log.error("runtime_events_truncated", { cursor, firstSeq: batch.firstSeq });
    }
    if (batch.cursor > cursor) cursor = batch.cursor;
    return batch.events;
  }

  async function runDrain(opts?: DrainOptions): Promise<RuntimeToolEvent[]> {
    if (!opts?.final) {
      // Intermediate: a single best-effort pull. A failure is retried on the
      // next boundary's drain — never throw, never block the stream.
      const batch = await fetchBatch();
      return batch ? consume(batch) : [];
    }

    // Final: drain until the journal returns nothing new, retrying transient
    // failures a bounded number of times. The sidecar dies after finalize, so
    // anything not pulled here is lost.
    const collected: RuntimeToolEvent[] = [];
    let attempts = 0;
    for (;;) {
      const batch = await fetchBatch();
      if (batch === null) {
        attempts += 1;
        if (attempts >= FINAL_RETRY_ATTEMPTS) {
          log.error("runtime_events_incomplete", { cursor, attempts });
          return collected;
        }
        await sleep(FINAL_RETRY_BASE_MS * attempts);
        continue;
      }
      attempts = 0;
      const events = consume(batch);
      if (events.length === 0) return collected;
      collected.push(...events);
    }
  }

  // Serialize drains. The cursor is read-then-advanced inside `runDrain`, and
  // the endpoint is non-consuming, so two overlapping `drain()` calls would
  // both fetch from the same cursor and emit the same events twice (the Pi
  // runner forwards tool calls that the SDK may dispatch in parallel). Chain
  // every call onto the previous one so only one drain is ever in flight.
  let tail: Promise<unknown> = Promise.resolve();
  function drain(opts?: DrainOptions): Promise<RuntimeToolEvent[]> {
    const result = tail.then(
      () => runDrain(opts),
      () => runDrain(opts),
    );
    // The chain link must never reject (a prior drain's failure shouldn't
    // poison the next); `runDrain` already never throws, but guard anyway.
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return { drain };
}

export interface DrainAndEmitOptions {
  /**
   * The run's drainer, or `undefined` when the run has no runtime tools — in
   * which case this is a no-op (resolves immediately without a network call).
   */
  drainer: RuntimeEventDrainer | undefined;
  /**
   * Emit one drained event on the run's single sink. Each event is stamped with
   * `runId` and a `timestamp` (see below) before being passed here.
   */
  emit: (event: RuntimeToolEvent) => Promise<void> | void;
  /** Clock for the fallback timestamp. */
  now: () => number;
  /** Run id stamped onto every emitted event. */
  runId: string;
  /**
   * Final drain before finalize: drain-until-empty + bounded retry, and emit
   * each event BEST-EFFORT — the run's verdict is already decided by this
   * point, so a dead sink here must NOT throw out of the caller and flip a
   * succeeded run to failed (a truly dead sink surfaces via finalize). In the
   * default (intermediate) mode emit failures propagate and fail the run.
   */
  final?: boolean;
}

/**
 * Drain the journal once and re-emit every pulled event on the run's sink,
 * stamped with `runId` and a `timestamp`. The single drain+stamp+emit step
 * keeps the cadence and the best-effort-at-finalize contract in one place.
 *
 * Timestamp precedence: `{ timestamp: now(), ...event, runId }` — the event's
 * OWN production-time stamp (set by `withEvents` when the sidecar journals it)
 * wins; `now()` only fills one in if the event somehow lacks it. This keeps the
 * canonical event time stable rather than overwriting it with the runner's
 * drain-time wall clock.
 */
export async function drainAndEmitInto(opts: DrainAndEmitOptions): Promise<void> {
  const { drainer, emit, now, runId, final } = opts;
  if (!drainer) return;
  for (const e of await drainer.drain(final ? { final: true } : undefined)) {
    const event: RuntimeToolEvent = { timestamp: now(), ...e, runId };
    if (final) {
      try {
        await emit(event);
      } catch {
        /* swallowed: run outcome decided elsewhere */
      }
    } else {
      await emit(event);
    }
  }
}
