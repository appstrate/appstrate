// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded concurrency for the Codex CLI engine — the codex twin of
 * {@link ../claude-agent/concurrency.ts}.
 *
 * Each chat turn on the `codex` path spawns a native `codex` subprocess (see
 * engine.ts). Thin instantiation of the shared {@link createConcurrencyGate} —
 * capped by `CHAT_CODEX_MAX_CONCURRENCY` (positive integer, default 6).
 */

import { createConcurrencyGate, type ConcurrencySlot } from "../concurrency-gate.ts";

const gate = createConcurrencyGate("CHAT_CODEX_MAX_CONCURRENCY");

/** A reserved subprocess slot. `release()` is idempotent (safe to call twice). */
export type CodexSlot = ConcurrencySlot;

/** Resolve the configured cap, falling back to the default on absent/invalid input. */
export const codexMaxConcurrency = (): number => gate.max();

/**
 * Try to reserve a subprocess slot. Returns the slot when below the cap, or
 * `null` when the engine is already at capacity (caller should 429).
 */
export const acquireCodexSlot = (): CodexSlot | null => gate.acquire();

/** Active reserved-slot count — for tests and observability. */
export const activeCodexSlots = (): number => gate.active();
