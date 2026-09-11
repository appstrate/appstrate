// SPDX-License-Identifier: Apache-2.0

/**
 * What a POSIX signal means for a run executing on the platform.
 *
 * `appstrate run @scope/agent` (remote mode) triggers a run server-side
 * and tails it. When the CLI is signalled, two readings are possible and
 * they are NOT interchangeable:
 *
 * - `"cancel"` — the human at the keyboard hit Ctrl-C to stop the agent.
 *   Cancelling the platform-side run is exactly what they asked for.
 * - `"detach"` — the process was reaped by something that was never
 *   talking to the agent: a CI step hitting its wrapper timeout, a
 *   supervisor recycling a worker, a harness killing a background shell.
 *   The run is healthy and already paid for; killing it is a side effect
 *   the caller never asked for. Closing a dashboard tab does not cancel a
 *   run — a reaped CLI should not either.
 *
 * The resolver below picks between the two. `--json` and a non-TTY stdin
 * both say "nobody is sitting at this terminal to have pressed Ctrl-C",
 * so the signal is a process-lifecycle event rather than a cancel intent.
 * An explicit flag always wins, in both directions.
 *
 * Why **stdin**, not stdout: Ctrl-C can only be delivered by a
 * controlling terminal, which is what stdin being a TTY attests to.
 * Probing stdout would flip the default for the extremely common
 * interactive `appstrate run … | tee log.txt`, where the user is very
 * much present and does mean cancel.
 */

export type SignalPolicy = "cancel" | "detach";

interface SignalPolicyInputs {
  /**
   * Tri-state `--cancel-on-exit` / `--no-cancel-on-exit`: `undefined`
   * when the user passed neither (auto), otherwise the explicit choice.
   */
  cancelOnExit?: boolean | undefined;
  /** `--json` — machine-readable output implies a machine caller. */
  json: boolean;
  /** Whether `process.stdin` is attached to a TTY. See {@link readStdinIsTty}. */
  stdinIsTty: boolean;
}

/**
 * Decide what a SIGINT/SIGTERM/SIGHUP does to the platform-side run.
 *
 * Pure by design (every input is injected) so the precedence table is
 * unit-testable without touching `process`.
 */
export function resolveSignalPolicy({
  cancelOnExit,
  json,
  stdinIsTty,
}: SignalPolicyInputs): SignalPolicy {
  if (cancelOnExit === true) return "cancel";
  if (cancelOnExit === false) return "detach";
  if (json) return "detach";
  if (!stdinIsTty) return "detach";
  return "cancel";
}

/**
 * Single impure probe, kept out of {@link resolveSignalPolicy} so the
 * decision stays testable. `process.stdin.isTTY` is `true` on a terminal
 * and `undefined` otherwise (never `false`), hence the strict compare.
 */
export function readStdinIsTty(): boolean {
  return process.stdin.isTTY === true;
}
