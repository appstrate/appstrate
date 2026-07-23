// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared thrown-failure epilogue for the Pi AFPS runner.
 *
 * The runner wraps its session loop in a `try/catch` whose catch arm
 * runs the same skeleton when the session throws (as opposed to ending
 * with an authoritative terminal verdict):
 *
 *   1. if the run was aborted, RETHROW immediately — the caller's
 *      `finally` owns cancellation cleanup, the runner must NOT finalize;
 *   2. surface the failure as a live `appstrate.error` event;
 *   3. best-effort final drain of any runtime events journaled before the
 *      throw (log/note/pin/output the agent produced mid-run);
 *   4. reduce the captured events into a {@link RunResult}, stamp the
 *      failure error + (optionally) `status = "failed"` + the runner's own
 *      token-usage snapshot, and `finalize` it.
 *
 * The pieces a runner may customise are injected so the epilogue stays
 * generic:
 *
 * - **usage** is PASSED IN, never computed here — the runner reads it
 *   from its own accumulator (`bridge.getUsage()` for Pi).
 * - **buildError** shapes the {@link RunError} from the message — the
 *   default is `{ message, stack }`.
 * - **stamp** applies any extra terminal fields after usage — Pi stamps
 *   `cost`.
 * - **setFailedStatus** controls the explicit `status = "failed"` stamp.
 *   Pi leaves `status` unset in its thrown path (preserved verbatim — this
 *   helper does not "fix" that).
 * - **transform** post-processes BOTH the emitted error event and the
 *   terminal result before finalize. The default is identity.
 *
 * The abort-rethrow MUST stay first, and the drain MUST be best-effort
 * (a dead drain cannot be allowed to mask the failure), so this helper
 * owns both invariants for the runner.
 */

import type { RunEvent } from "@afps-spec/types";
import { reduceEvents } from "./reducer.ts";
import type { RunError, RunResult, TokenUsage } from "../types/run-result.ts";

/** Minimal sink surface the epilogue needs — just the terminal `finalize`. */
interface FinalizeSink {
  finalize(result: RunResult): Promise<void>;
}

export interface FinalizeThrownFailureOptions {
  /** Events captured so far (also the reducer input). */
  events: RunEvent[];
  /** The error thrown out of the session loop. */
  err: unknown;
  /** Abort signal — when already aborted, `err` is rethrown and nothing is finalized. */
  signal: AbortSignal | undefined;
  /** Run id stamped onto the emitted `appstrate.error` event. */
  runId: string;
  /** Clock — used for the error event timestamp. */
  now: () => number;
  /** The run's single event sink writer (captures + forwards each event). */
  emit: (event: RunEvent) => Promise<void>;
  /**
   * Best-effort final drain (journaled runtime events). Invoked before the
   * result is reduced; this helper guarantees it cannot throw past it.
   */
  drainAndEmit: () => Promise<void>;
  /** Terminal sink. */
  eventSink: FinalizeSink;
  /**
   * Runner-sourced token-usage snapshot stamped onto the failed result.
   * Very early failures must pass an explicit zero snapshot.
   */
  usage: TokenUsage;
  /**
   * Builds the {@link RunError} attached to the reduced result. Defaults to
   * `{ message, stack }`.
   */
  buildError?: (message: string, err: unknown) => RunError;
  /** Stamp the terminal status on the result. Defaults to `true`. */
  setFailedStatus?: boolean;
  /**
   * Terminal status stamped when {@link setFailedStatus} is not `false`.
   * Defaults to `"failed"`. A runner-enforced timeout passes `"timeout"`
   * so the run surfaces its specific terminal cause instead of a generic
   * failure. Ignored when `setFailedStatus === false`.
   */
  terminalStatus?: NonNullable<RunResult["status"]>;
  /** Extra terminal stamping (cost / durationMs) applied after `usage`. */
  stamp?: (result: RunResult, usage: TokenUsage) => void;
  /** Transform applied to the emitted error event AND the terminal result. Defaults to identity. */
  transform?: <T>(value: T) => T;
}

/** Same extraction as `@appstrate/core/errors`' `getErrorMessage`, inlined to keep this package dep-free. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function finalizeThrownFailure(opts: FinalizeThrownFailureOptions): Promise<void> {
  const { events, err, signal, runId, now, emit, drainAndEmit, eventSink, usage } = opts;

  // 1. Cancellation: propagate without finalizing — the caller's finally
  //    block decides. MUST stay first so an aborted run never produces a
  //    spurious `failed` finalize.
  if (signal?.aborted) throw err;

  const transform = opts.transform ?? (<T>(value: T): T => value);
  const message = errorMessage(err);
  const buildError =
    opts.buildError ??
    ((m: string, e: unknown): RunError => ({
      message: m,
      stack: e instanceof Error ? e.stack : undefined,
    }));
  const resultError = buildError(message, err);

  // 2. Surface the failure as a live event (transformed first so a
  //    redaction transform scrubs it before it reaches the sink).
  const errorEvent: RunEvent = {
    type: "appstrate.error",
    timestamp: now(),
    runId,
    message: resultError.message,
  };
  await emit(transform(errorEvent));

  // 3. Best-effort final drain: capture any runtime events journaled before
  //    the session threw. A dead drain must NOT mask the failure.
  try {
    await drainAndEmit();
  } catch {
    /* best-effort — the run outcome is decided below regardless */
  }

  // 4. Reduce → stamp → finalize. `reduceEvents` (not emptyRunResult) so any
  //    partial canonical output the agent emitted before the throw survives.
  const result = reduceEvents(events, { error: resultError });
  if (opts.setFailedStatus !== false) result.status = opts.terminalStatus ?? "failed";
  result.usage = usage;
  opts.stamp?.(result, usage);
  await eventSink.finalize(transform(result));
}
