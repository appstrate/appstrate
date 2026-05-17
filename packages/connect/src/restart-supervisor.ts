// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1.2a — restart-with-backoff supervisor for MCP subprocesses
 * (proposal §5.4.2).
 *
 * Wraps an injected `spawn` function. When the underlying process exits
 * unexpectedly, the supervisor restarts it with a fixed backoff schedule
 * (defaults: `[1000, 5000, 15000]` ms). After all attempts in the schedule
 * are exhausted, the supervisor declares the process **fatally dead** and
 * the consumer can propagate the error to the agent.
 *
 * Pure logic + injectable I/O boundaries so the test suite stays hermetic:
 *   - `spawn` — async factory returning a {@link ChildHandle}. The handle's
 *     `exited` promise resolves with the exit reason; rejection counts as
 *     a "the process couldn't even start" failure (also restarts).
 *   - `sleep` — replaces `setTimeout` so tests can advance the clock.
 *   - `now` — replaces `Date.now()` for telemetry; defaults to wall clock.
 *
 * What this module DOES NOT do (deferred):
 *   - Per-call cancellation (the consumer calls `stop()` once).
 *   - Resource accounting (CPU / RAM caps) — that lives on the spawn
 *     layer (`Bun.spawn` ulimits + cgroup).
 *   - Reset of the attempt counter on a long-running healthy spell —
 *     intentionally absent for Phase 1.2a (spec §5.4.2 reads "3 attempts
 *     puis erreur fatale" as monotonic). A later phase may add an
 *     "uptime-window resets the counter" knob.
 */

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

/** Per-spawn handle returned by the consumer-supplied factory. */
export interface ChildHandle {
  /** Resolves when the child exits, with a reason the supervisor logs. */
  exited: Promise<ChildExit>;
  /** Best-effort kill (called when the supervisor decides to give up). */
  kill(reason: string): void;
}

export type ChildExit =
  | { kind: "normal-exit"; code: number }
  | { kind: "signal"; signal: string }
  | { kind: "error"; error: unknown };

export interface SupervisorEvent {
  type:
    | "spawn-success"
    | "spawn-failure"
    | "child-exited"
    | "restart-scheduled"
    | "max-attempts-reached"
    | "stopped";
  attempt: number;
  /** Wall-clock timestamp (`now()`). */
  at: number;
  /** Backoff in ms when `type === "restart-scheduled"`. */
  delayMs?: number;
  /** Child exit reason (when present). */
  exit?: ChildExit;
}

export interface SupervisorOutcome {
  ok: boolean;
  /** Why the supervisor terminated. */
  reason: "max-restarts" | "stopped";
  /** Total restart attempts (1-indexed). */
  attempts: number;
  /** Last child exit reason (for diagnostics). */
  lastExit?: ChildExit;
}

export interface SupervisorOptions {
  /**
   * Per-attempt backoff (ms). The Nth restart waits `schedule[N-1]` ms
   * before re-spawning. The schedule length caps total attempts.
   * Defaults to `[1000, 5000, 15000]` per spec §5.4.2.
   */
  schedule?: readonly number[];
  /** Injectable sleep — replaces `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable wall clock — replaces `Date.now`. */
  now?: () => number;
  /** Telemetry sink — every state change fires one event. */
  onEvent?: (event: SupervisorEvent) => void;
}

const DEFAULT_SCHEDULE = [1000, 5000, 15000] as const;

/**
 * Run a supervised process until either it gives up (max attempts) or
 * the consumer calls `stop()`. The returned `done` promise resolves with
 * the terminal outcome — the consumer typically `await`s it and then
 * propagates the failure to the agent.
 */
export interface SupervisedProcess {
  /** Resolves when the supervisor has terminated for any reason. */
  readonly done: Promise<SupervisorOutcome>;
  /** Give up on the process; resolves once teardown completes. */
  stop(): Promise<void>;
  /** Current attempt count (0 before first spawn). */
  attemptCount(): number;
}

/**
 * Wire a supervisor around the consumer-supplied `spawn` factory.
 * Returns immediately; the consumer drives lifecycle via `done` + `stop`.
 *
 * The supervisor counts an attempt every time `spawn()` is invoked. The
 * first spawn is attempt 1; the schedule[0] backoff applies before
 * attempt 2 (i.e. the FIRST restart). With the default schedule the
 * timeline is:
 *   - t=0:        attempt 1 spawned
 *   - t=N1:       attempt 1 exits  → wait 1s
 *   - t=N1+1s:    attempt 2 spawned
 *   - t=N2:       attempt 2 exits  → wait 5s
 *   - t=N2+5s:    attempt 3 spawned
 *   - t=N3:       attempt 3 exits  → no more entries → max-restarts
 */
export function superviseProcess(
  spawn: () => Promise<ChildHandle>,
  options: SupervisorOptions = {},
): SupervisedProcess {
  const schedule = options.schedule ?? DEFAULT_SCHEDULE;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const onEvent = options.onEvent ?? noopEvent;

  if (schedule.length === 0) {
    throw new Error("superviseProcess: schedule must contain at least one entry");
  }

  const state = {
    attempts: 0,
    current: null as ChildHandle | null,
    stopRequested: false,
    lastExit: undefined as ChildExit | undefined,
  };

  const loop = (async (): Promise<SupervisorOutcome> => {
    // First spawn = attempt 1 (no backoff). Subsequent restarts each cost
    // one entry off `schedule` — total of `schedule.length + 1` attempts.
    let firstSpawn = true;
    while (!state.stopRequested) {
      if (!firstSpawn) {
        const idx = state.attempts - 1; // attempts already incremented for the failed attempt
        const delayMs = schedule[Math.min(idx, schedule.length - 1)]!;
        if (idx >= schedule.length) {
          onEvent({ type: "max-attempts-reached", attempt: state.attempts, at: now() });
          return {
            ok: false,
            reason: "max-restarts",
            attempts: state.attempts,
            ...(state.lastExit !== undefined ? { lastExit: state.lastExit } : {}),
          };
        }
        onEvent({ type: "restart-scheduled", attempt: state.attempts + 1, at: now(), delayMs });
        await sleep(delayMs);
        if (state.stopRequested) break;
      }
      firstSpawn = false;
      state.attempts += 1;

      let handle: ChildHandle;
      try {
        handle = await spawn();
        state.current = handle;
        onEvent({ type: "spawn-success", attempt: state.attempts, at: now() });
      } catch (error) {
        const exit: ChildExit = { kind: "error", error };
        state.lastExit = exit;
        onEvent({ type: "spawn-failure", attempt: state.attempts, at: now(), exit });
        // Treat spawn failure exactly like a crash — let the loop schedule
        // a restart on the next iteration.
        continue;
      }

      let exit: ChildExit;
      try {
        exit = await handle.exited;
      } catch (error) {
        exit = { kind: "error", error };
      }
      state.current = null;
      state.lastExit = exit;
      onEvent({ type: "child-exited", attempt: state.attempts, at: now(), exit });
    }

    onEvent({ type: "stopped", attempt: state.attempts, at: now() });
    return {
      ok: false,
      reason: "stopped",
      attempts: state.attempts,
      ...(state.lastExit !== undefined ? { lastExit: state.lastExit } : {}),
    };
  })();

  return {
    done: loop,
    attemptCount: () => state.attempts,
    async stop() {
      if (state.stopRequested) {
        // Already requested — await the same loop.
        await loop.catch(() => {});
        return;
      }
      state.stopRequested = true;
      if (state.current) {
        try {
          state.current.kill("supervisor-stop");
        } catch {
          // Kill is best-effort; the loop will see the exit reason.
        }
      }
      await loop.catch(() => {});
    },
  };
}

// ─────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function noopEvent(_event: SupervisorEvent): void {}
