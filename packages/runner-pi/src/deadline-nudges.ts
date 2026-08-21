// SPDX-License-Identifier: Apache-2.0

/**
 * Deadline nudges — mid-run wall-clock steering (#1029).
 *
 * The run budget is stated exactly once, in the system prompt built at turn 1
 * (`renderPlatformPrompt` → "You have N seconds to complete this task"). The
 * model has no clock afterwards: it cannot observe elapsed time, and nothing in
 * the loop re-states it. The observed failure mode is an agent that explores
 * comfortably for the whole budget and is killed by the runner's watchdog at
 * 100% — with its deliverable never emitted, so a fully-paid run finalizes as a
 * `timeout` with nothing to show.
 *
 * This module re-states the remaining budget at two checkpoints, as *steering
 * messages* on the live session. Why steering and not any of the alternatives:
 *   - `AgentSession.steer(text)` queues a user message the SDK delivers after
 *     the current assistant turn finishes its tool calls, before the next LLM
 *     call — so the agent is interrupted at a turn boundary, never mid-tool.
 *   - Appending a user message does NOT invalidate the Anthropic prompt-cache
 *     prefix (cache breakpoints sit on the system block and the last tool
 *     definition), unlike a `setActiveToolsByName` narrowing. A nudge costs one
 *     short uncached suffix, not a full re-read of the session.
 *   - Re-prompting AFTER the watchdog fires was considered and rejected: the
 *     platform's own safety net is only `timeout + 90s` measured from container
 *     start, and cold start eats most of that margin. There is no room for a
 *     corrective turn once the budget is spent — the nudge has to land while
 *     the agent still has time to act on it.
 *
 * The scheduler is fully injectable (timers + clock) so its behaviour is unit
 * tested without real time passing.
 */

import type { RunEvent } from "@appstrate/afps-runtime/types";

/**
 * Fractions of the run budget at which the agent is reminded of the clock.
 *
 * 75% — still enough runway to re-plan and cut optional work.
 * 90% — only enough runway to land what is already in hand.
 *
 * Deliberately only two: each nudge is an extra user turn the model has to read
 * and react to, and a nagging cadence would itself burn the budget it is trying
 * to protect.
 */
export const DEADLINE_NUDGE_FRACTIONS = [0.75, 0.9] as const;

/**
 * `run_logs` event name carried in each nudge breadcrumb's `data`, so the drift
 * this feature targets is measurable rather than assumed
 * (`SELECT count(*) FROM run_logs WHERE data->>'event' = 'deadline_nudge'`).
 * Mirrors the `output_reprompt` precedent in `pi-runner.ts`.
 */
export const DEADLINE_NUDGE_EVENT = "deadline_nudge";

/**
 * Model-facing text for a checkpoint.
 *
 * Tool-agnostic by contract (#368, documented in
 * `@appstrate/afps-runtime/bundle/platform-prompt`): which tools exist varies
 * per agent, so platform-authored prose never names one — "the appropriate
 * tool" is taught by each tool's MCP `description`, not from here. Naming
 * `output` / `publish_document` would produce instructions for tools half the
 * agents do not have.
 *
 * Numbers are computed from the checkpoint, never hardcoded in the prose.
 */
function nudgeText(remainingSeconds: number, timeoutSeconds: number, final: boolean): string {
  if (final) {
    return (
      `Time check: about ${remainingSeconds} seconds remain of your ${timeoutSeconds}-second budget. ` +
      "Stop starting new work — finish the step you are on and deliver your result through the " +
      "appropriate tool now. Anything not delivered before the budget ends is lost with this container."
    );
  }
  return (
    `Time check: about ${remainingSeconds} seconds remain of your ${timeoutSeconds}-second budget. ` +
    "Re-plan for the time you actually have left, not for the task you would do with unlimited time. " +
    "Drop optional exploration and keep only what is needed to deliver a result."
  );
}

interface DeadlineNudgeDeps {
  /** The run's wall-clock budget. `<= 0` (or non-finite) disables nudging entirely. */
  timeoutSeconds: number;
  /** Queues a steering message on the live session (`AgentSession.steer`). */
  steer: (text: string) => Promise<void>;
  /** Best-effort breadcrumb channel. Sync or async; failures are swallowed. */
  emit?: (event: RunEvent) => void | Promise<void>;
  runId: string;
  /** Timer injection for tests — production uses the globals. */
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Clock override for tests (breadcrumb timestamps only). */
  now?: () => number;
}

/**
 * Run `call()` and discard its outcome, whether it throws synchronously or
 * rejects. Neither a lost breadcrumb nor a refused steer may surface as an
 * unhandled rejection or fail the run — the nudge is an optimisation, the run
 * is the product.
 */
function fireAndForget(call: () => unknown): void {
  try {
    void Promise.resolve(call()).catch(() => {
      // swallowed: see doc comment
    });
  } catch {
    // synchronous throw — same swallow
  }
}

/**
 * Arm the deadline nudges for one session.
 *
 * @returns a cancel function. It clears the pending timers AND latches a flag,
 *   so a timer that already fired (or one an injected/unref'd scheduler still
 *   delivers) is a no-op — a nudge must never reach a session whose prompt has
 *   already settled.
 */
export function scheduleDeadlineNudges(deps: DeadlineNudgeDeps): () => void {
  const { timeoutSeconds, steer, emit, runId } = deps;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const now = deps.now ?? Date.now;

  // No budget → no deadline to warn about. Matches `run()`, which only arms its
  // watchdog on `timeoutSeconds > 0`.
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return () => {
      // nothing was scheduled
    };
  }

  let cancelled = false;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  for (const fraction of DEADLINE_NUDGE_FRACTIONS) {
    const remainingSeconds = Math.round(timeoutSeconds * (1 - fraction));
    const isFinal = fraction === DEADLINE_NUDGE_FRACTIONS[DEADLINE_NUDGE_FRACTIONS.length - 1];
    timers.push(
      setTimer(
        () => {
          if (cancelled) return;
          // Breadcrumb first (mirrors `maybeRepromptForOutput`), but the steer is
          // NOT downstream of it: an emit that throws must still leave the agent
          // warned.
          fireAndForget(() =>
            emit?.({
              type: "appstrate.progress",
              timestamp: now(),
              runId,
              message: `Deadline nudge at ${Math.round(fraction * 100)}% of the run budget — ~${remainingSeconds}s left`,
              data: { event: DEADLINE_NUDGE_EVENT, remainingSeconds, fraction },
              level: "info",
            }),
          );
          fireAndForget(() => steer(nudgeText(remainingSeconds, timeoutSeconds, isFinal)));
        },
        timeoutSeconds * fraction * 1000,
      ),
    );
  }

  return () => {
    cancelled = true;
    for (const timer of timers) clearTimer(timer);
  };
}
