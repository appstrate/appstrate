// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded in-process concurrency for the Claude Agent SDK chat engine.
 *
 * Each `claude-code` chat turn forks a native `claude` binary inside the single
 * `apps/api` process — which also serves runs, auth, and everything else — so
 * without a ceiling a burst of concurrent chats would fork an unbounded number
 * of binaries and exhaust memory/CPU for the whole instance. This is a simple
 * counting gate (one counter per instance); when saturated `acquireClaudeSlot()`
 * returns `null` so the engine can 429 (see {@link chatCapacityResponse}) and
 * the client backs off instead of piling on more subprocesses.
 *
 * The cap is read from `CHAT_CLAUDE_MAX_CONCURRENCY` (positive integer, default
 * 6) — an opt-in module knob, not a core env-schema field.
 */

const DEFAULT_MAX_CONCURRENCY = 6;
const ENV_VAR = "CHAT_CLAUDE_MAX_CONCURRENCY";

/** A reserved subprocess slot. `release()` is idempotent (safe to call twice). */
export interface ClaudeSlot {
  release(): void;
}

let active = 0;

/** Resolve the configured cap, falling back to the default on absent/invalid input. */
export const claudeMaxConcurrency = (): number => {
  const raw = process.env[ENV_VAR];
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
};

/**
 * Try to reserve a subprocess slot. Returns the slot when below the cap, or
 * `null` when the engine is already at capacity (caller should 429).
 */
export const acquireClaudeSlot = (): ClaudeSlot | null => {
  if (active >= claudeMaxConcurrency()) return null;
  active += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      active -= 1;
    },
  };
};

/** Active reserved-slot count — for tests and observability. */
export const activeClaudeSlots = (): number => active;

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
