// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared failure epilogue for the official-binary runners (claude / codex).
 *
 * Both runners' catch blocks (and codex's in-try non-zero-exit branch) share the
 * SAME structurally-identical failure tail: fold the events accumulated so far
 * into a `RunResult` (so any partial canonical output the agent emitted before
 * the throw — `memory.added` / `output.emitted` / `log.written` — survives),
 * stamp an unambiguous `status: "failed"`, attach the usage already spent before
 * the failure, optionally deep-scrub the result by VALUE (codex's vended-token
 * redaction), and `finalize`. This helper owns that control flow so it cannot
 * drift between the two runners.
 *
 * The justified per-runner divergence stays INJECTED, not duplicated:
 *   - `usage` — claude pulls a live snapshot off its SDK mapper; codex reads its
 *     own mapper's counters. The caller computes it; the helper only stamps it.
 *   - `redact` — codex passes a value-based deep-scrub (the vended subscription
 *     token can ride the raw error message); claude passes nothing (no in-run
 *     credential at rest). Applied to the whole result as a final pass.
 *   - `cost` / `durationMs` — codex stamps an equivalent cost + wall-clock
 *     duration; claude leaves them to the reducer. Optional, stamped when given.
 *
 * The caller is responsible for everything BEFORE the epilogue that legitimately
 * differs — emitting the `appstrate.error` event, the best-effort final drain,
 * and (codex) the prior token redaction of emitted events — because their
 * ordering/source is runner-specific. By the time `finalizeFailure` runs, the
 * verdict is already a failure; this helper just assembles + ships the result.
 *
 * Abort semantics are unchanged: this helper is only reached AFTER the caller
 * has decided NOT to propagate an abort (a cancelled run rethrows before here,
 * letting the caller's `finally` decide — see each runner's catch guard).
 */

import { reduceEvents } from "./reducer.ts";
import type { RunError, RunResult } from "../types/run-result.ts";
import type { RunEvent } from "@afps-spec/types";

export interface FinalizeFailureOptions {
  /** Events accumulated so far (scrubbed already, where the runner scrubs). */
  events: RunEvent[];
  /** The terminal error folded into the result + reducer. */
  error: RunError;
  /** Authoritative usage spent before the failure (mapper snapshot). */
  usage: RunResult["usage"];
  /** The run's event sink — `finalize` ships the assembled result. */
  finalize: (result: RunResult) => Promise<void>;
  /** Optional equivalent cost (codex). Stamped when provided. */
  cost?: RunResult["cost"];
  /** Optional wall-clock duration in ms (codex). Stamped when provided. */
  durationMs?: number;
  /**
   * Optional final value-based scrub applied to the WHOLE result before it
   * leaves the runner (codex's vended-token redaction). Identity when omitted.
   */
  redact?: (result: RunResult) => RunResult;
}

/**
 * Assemble + finalize a failed `RunResult` from the shared epilogue. Returns
 * once the sink's `finalize` has resolved.
 */
export async function finalizeFailure(opts: FinalizeFailureOptions): Promise<void> {
  const reduced = reduceEvents(opts.events, { error: opts.error });
  // Explicit, runner-authoritative verdict (the reducer leaves `status` absent;
  // a thrown/failed binary stream is unambiguously a failure).
  reduced.status = "failed";
  // Stamp the tokens already spent before the failure (the binary never emitted
  // its authoritative terminal usage, so without this they'd be lost as zero).
  reduced.usage = opts.usage;
  if (opts.cost !== undefined) reduced.cost = opts.cost;
  if (opts.durationMs !== undefined) reduced.durationMs = opts.durationMs;
  const result = opts.redact ? opts.redact(reduced) : reduced;
  await opts.finalize(result);
}
