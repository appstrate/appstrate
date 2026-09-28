// SPDX-License-Identifier: Apache-2.0

/** Run-status literals, the single source of truth. MUST stay import-free (the SPA imports it). */

export const runStatusValues = [
  "pending",
  "running",
  "success",
  "failed",
  "timeout",
  "cancelled",
] as const;

export type RunStatus = (typeof runStatusValues)[number];

/** Terminal run statuses — runs in any of these states are no longer progressing. */
export const terminalRunStatusValues = ["success", "failed", "timeout", "cancelled"] as const;
export type TerminalRunStatus = (typeof terminalRunStatusValues)[number];

/** Active (non-terminal) run statuses. */
export const activeRunStatusValues = ["pending", "running"] as const;
