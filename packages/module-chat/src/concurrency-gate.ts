// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded in-process concurrency gate for the subprocess-spawning chat engines
 * (Claude Agent SDK, Codex CLI). Each chat turn on those paths forks a native
 * binary inside the single `apps/api` process — which also serves runs, auth,
 * and everything else — so without a ceiling a burst of concurrent chats would
 * fork an unbounded number of binaries and exhaust memory/CPU for the whole
 * instance. This is a simple counting gate (one counter per instance); when
 * saturated `acquire()` returns `null` so the engine can 429 and the client
 * backs off instead of piling on more subprocesses.
 *
 * The cap is read from `process.env` (positive integer, default 6) to match the
 * module's existing `CHAT_DEBUG` convention — an opt-in module knob, not a core
 * env-schema field. Each engine instantiates one gate with its own env var.
 */

const DEFAULT_MAX_CONCURRENCY = 6;

/** A reserved subprocess slot. `release()` is idempotent (safe to call twice). */
export interface ConcurrencySlot {
  release(): void;
}

export interface ConcurrencyGate {
  /** Resolve the configured cap, falling back to the default on absent/invalid input. */
  max(): number;
  /**
   * Try to reserve a subprocess slot. Returns the slot when below the cap, or
   * `null` when already at capacity (caller should 429).
   */
  acquire(): ConcurrencySlot | null;
  /** Active reserved-slot count — for tests and observability. */
  active(): number;
}

/**
 * Build an independent concurrency gate backed by its own counter, capped by the
 * given env var (positive integer, default 6).
 */
export function createConcurrencyGate(
  envVar: string,
  defaultMax: number = DEFAULT_MAX_CONCURRENCY,
): ConcurrencyGate {
  let active = 0;

  const max = (): number => {
    const raw = process.env[envVar];
    if (!raw) return defaultMax;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 ? n : defaultMax;
  };

  return {
    max,
    acquire(): ConcurrencySlot | null {
      if (active >= max()) return null;
      active += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          active -= 1;
        },
      };
    },
    active: () => active,
  };
}

/**
 * RFC 9457 `429` returned (instead of a stream) when a chat engine is at its
 * subprocess cap, so the client backs off rather than the instance forking
 * unbounded binaries. Engine-agnostic — the service label in the detail is the
 * only per-engine variation (today only the Claude subscription engine spawns a
 * capped subprocess; the ai-sdk path is in-process).
 */
export function chatCapacityResponse(serviceLabel: string): Response {
  const retryAfterSeconds = 5;
  return new Response(
    JSON.stringify({
      type: "https://docs.appstrate.dev/errors/chat-capacity",
      title: "Too Many Requests",
      status: 429,
      detail: `Le service de chat ${serviceLabel} est temporairement saturé. Réessayez dans quelques instants.`,
      code: "chat_capacity",
      retry_after: retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/problem+json",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}
