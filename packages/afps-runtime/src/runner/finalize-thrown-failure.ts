// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Shared thrown-failure epilogue for AFPS runners.
 *
 * Every official-binary runner (`runner-claude`, `runner-codex`,
 * `runner-pi`) wraps its session loop in a `try/catch` whose catch arm
 * runs the same skeleton when the session throws (as opposed to ending
 * with an authoritative terminal verdict):
 *
 *   1. if the run was aborted, RETHROW immediately — the caller's
 *      `finally` owns cancellation cleanup, the runner must NOT finalize;
 *   2. surface the failure as a live `appstrate.error` event;
 *   3. best-effort final drain of any runtime events journaled before the
 *      throw (log/note/pin/report/output the agent produced mid-run);
 *   4. reduce the captured events into a {@link RunResult}, stamp the
 *      failure error + (optionally) `status = "failed"` + the runner's own
 *      token-usage snapshot, and `finalize` it.
 *
 * The pieces that legitimately differ between runners are injected:
 *
 * - **usage** is PASSED IN, never computed here — each runner reads it
 *   from its own accumulator (`mapper.liveUsageSnapshot()` for Claude,
 *   `mapper.usage()` for Codex, `bridge.getUsage()` for Pi).
 * - **buildError** shapes the {@link RunError} from the message — the
 *   default is `{ message, stack }`; Codex overrides it to stamp
 *   `code: "adapter_error"` (and no stack).
 * - **stamp** applies any extra terminal fields after usage — Codex
 *   stamps `cost` + `durationMs`, Pi stamps `cost`; Claude stamps neither.
 * - **setFailedStatus** controls the explicit `status = "failed"` stamp.
 *   Claude + Codex set it; Pi leaves `status` unset in its thrown path
 *   (preserved verbatim — this helper does not "fix" that).
 * - **transform** post-processes BOTH the emitted error event and the
 *   terminal result before finalize. The default is identity; Codex
 *   passes `redactSecretsDeep(_, knownSecrets)` so a vended subscription
 *   token can never ride out on the error event or the terminal
 *   `RunResult` (its `emit` closure already scrubs every event, so the
 *   event pass is idempotent — the result pass is the load-bearing one).
 *
 * The abort-rethrow MUST stay first, and the drain MUST be best-effort
 * (a dead drain cannot be allowed to mask the failure), so this helper
 * owns both invariants for all three runners.
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
   * Pass `undefined` to leave `result.usage` unset — the Pi runner does this
   * when the session bridge was never captured (a very early throw), so the
   * failed result carries no usage rather than a spurious zero snapshot.
   */
  usage: TokenUsage | undefined;
  /**
   * Builds the {@link RunError} attached to the reduced result. Defaults to
   * `{ message, stack }`; Codex overrides to `{ code: "adapter_error", message }`.
   */
  buildError?: (message: string, err: unknown) => RunError;
  /** Stamp `status = "failed"` on the result. Defaults to `true`. */
  setFailedStatus?: boolean;
  /** Extra terminal stamping (cost / durationMs) applied after `usage`. */
  stamp?: (result: RunResult, usage: TokenUsage | undefined) => void;
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

  // 2. Surface the failure as a live event (transformed first so a
  //    redaction transform scrubs it before it reaches the sink).
  const errorEvent: RunEvent = { type: "appstrate.error", timestamp: now(), runId, message };
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
  const buildError =
    opts.buildError ??
    ((m: string, e: unknown): RunError => ({
      message: m,
      stack: e instanceof Error ? e.stack : undefined,
    }));
  const result = reduceEvents(events, { error: buildError(message, err) });
  if (opts.setFailedStatus !== false) result.status = "failed";
  if (usage !== undefined) result.usage = usage;
  opts.stamp?.(result, usage);
  await eventSink.finalize(transform(result));
}
