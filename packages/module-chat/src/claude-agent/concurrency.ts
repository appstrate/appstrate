// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded concurrency for the Claude Agent SDK engine.
 *
 * Each chat turn on the `claude-code` path spawns a native `claude` subprocess
 * (see engine.ts). Thin instantiation of the shared {@link createConcurrencyGate}
 * — capped by `CHAT_CLAUDE_MAX_CONCURRENCY` (positive integer, default 6).
 */

import { createConcurrencyGate, type ConcurrencySlot } from "../concurrency-gate.ts";

const gate = createConcurrencyGate("CHAT_CLAUDE_MAX_CONCURRENCY");

/** A reserved subprocess slot. `release()` is idempotent (safe to call twice). */
export type ClaudeSlot = ConcurrencySlot;

/** Resolve the configured cap, falling back to the default on absent/invalid input. */
export const claudeMaxConcurrency = (): number => gate.max();

/**
 * Try to reserve a subprocess slot. Returns the slot when below the cap, or
 * `null` when the engine is already at capacity (caller should 429).
 */
export const acquireClaudeSlot = (): ClaudeSlot | null => gate.acquire();

/** Active reserved-slot count — for tests and observability. */
export const activeClaudeSlots = (): number => gate.active();
