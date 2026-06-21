// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded concurrency for the Codex CLI engine — the codex twin of
 * {@link ../claude-agent/concurrency.ts}. Each chat turn on the `codex` path
 * spawns a native `codex` subprocess inside the single `apps/api` process; a
 * burst of concurrent chats would otherwise fork unbounded binaries and exhaust
 * the instance. Simple in-process counting gate; when saturated the engine
 * returns 429 so the client backs off.
 *
 * Cap via `CHAT_CODEX_MAX_CONCURRENCY` (positive integer, default 6), read from
 * `process.env` to match the module's `CHAT_DEBUG` / `CHAT_CLAUDE_*` convention.
 */

const DEFAULT_MAX_CONCURRENCY = 6;

export function codexMaxConcurrency(): number {
  const raw = process.env.CHAT_CODEX_MAX_CONCURRENCY;
  if (!raw) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CONCURRENCY;
}

let active = 0;

export interface CodexSlot {
  release(): void;
}

export function acquireCodexSlot(): CodexSlot | null {
  if (active >= codexMaxConcurrency()) return null;
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

export function activeCodexSlots(): number {
  return active;
}
