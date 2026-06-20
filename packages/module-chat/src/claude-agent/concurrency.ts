// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded concurrency for the Claude Agent SDK engine.
 *
 * Each chat turn on the `claude-code` path spawns a native `claude` subprocess
 * (see engine.ts). The ai-sdk path has no subprocess, so this resource cost is
 * new: without a ceiling, a burst of concurrent chats would fork an unbounded
 * number of binaries inside the single `apps/api` process — which also serves
 * runs, auth, and everything else — and can exhaust memory/CPU for the whole
 * instance. This is a simple in-process counting gate (one instance, one
 * counter); when saturated the engine returns 429 so the client backs off
 * instead of piling on more subprocesses.
 *
 * Cap via `CHAT_CLAUDE_MAX_CONCURRENCY` (positive integer, default 6), read
 * from `process.env` to match the module's existing `CHAT_DEBUG` convention —
 * an opt-in module knob, not a core env-schema field.
 */

const DEFAULT_MAX_CONCURRENCY = 6;

/** Resolve the configured cap, falling back to the default on absent/invalid input. */
export function claudeMaxConcurrency(): number {
  const raw = process.env.CHAT_CLAUDE_MAX_CONCURRENCY;
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
}

let active = 0;

/** A reserved subprocess slot. `release()` is idempotent (safe to call twice). */
export interface ClaudeSlot {
  release(): void;
}

/**
 * Try to reserve a subprocess slot. Returns the slot when below the cap, or
 * `null` when the engine is already at capacity (caller should 429).
 */
export function acquireClaudeSlot(): ClaudeSlot | null {
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
}

/** Active reserved-slot count — for tests and observability. */
export function activeClaudeSlots(): number {
  return active;
}
