// SPDX-License-Identifier: Apache-2.0

/**
 * Runner engine selection (plan §5 / Phase 3).
 *
 * Which in-container agent engine a run executes on. Pi (the
 * `@mariozechner/pi-coding-agent` loop) is the default for everything; a
 * `claude-code` subscription run executes on the official **Claude Agent SDK**
 * instead — the ToS-clean path that lets the official `claude` binary sign its
 * own client fingerprint, removing the sidecar `oauthWireFormat` forging the
 * Pi path relies on for subscriptions.
 *
 * Selection is gated by `RUNNER_CLAUDE_ENGINE` (a transition flag + kill-switch
 * — see `@appstrate/env`): when off, even `claude-code` stays on Pi, so the new
 * engine can land dark and flip in one place once validated.
 */

/** The in-container agent engine for a run. */
export type RunEngine = "pi" | "claude";

/** Provider id of the Claude Pro/Max/Team subscription credential. */
const CLAUDE_CODE_PROVIDER_ID = "claude-code";

/**
 * Pick the engine for a resolved model. `claude-code` → `"claude"` only when
 * the Claude engine is enabled; everything else (and `claude-code` while the
 * flag is off) → `"pi"`. Pure for unit testing — the caller reads the flag.
 */
export function selectRunEngine(
  resolved: { providerId: string },
  claudeEngineEnabled: boolean,
): RunEngine {
  if (claudeEngineEnabled && resolved.providerId === CLAUDE_CODE_PROVIDER_ID) {
    return "claude";
  }
  return "pi";
}
