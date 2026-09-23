// SPDX-License-Identifier: Apache-2.0

/**
 * Run-status literals — the single source of truth for the `run_status`
 * value set.
 *
 * Lives in core, not in `@appstrate/db`, because db depends on core and core
 * needs the set too (`run-and-wait-client.ts`, the module event contract).
 * `@appstrate/db/run-status` derives its sets and its `pgEnum` from these
 * tuples, never the other way round.
 *
 * **This module MUST stay import-free**: it reaches the browser bundle through
 * `@appstrate/db/run-status` → `@appstrate/shared-types`.
 */

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

/**
 * Active (non-terminal) run statuses. Kept as its own tuple so adding a status
 * to {@link runStatusValues} forces an explicit decision about which set it
 * belongs to.
 */
export const activeRunStatusValues = ["pending", "running"] as const;
