// SPDX-License-Identifier: Apache-2.0

/**
 * Run-status literals — the single source of truth for the `run_status`
 * value set.
 *
 * **This module MUST stay import-free.** It is the one piece of the DB
 * package the browser bundle is allowed to reach: `@appstrate/shared-types`
 * re-exports these values to the SPA, and any import added here (drizzle-orm,
 * zod, another schema file) would be dragged into the eager entry graph along
 * with the rest of the schema barrel — which also leaked table/column names
 * (`llm_usage`, `oauth_clients`, `end_users`, …) into a public asset.
 *
 * The Drizzle `pgEnum` and the Zod validator DERIVE from these tuples
 * (`schema/enums.ts`), never the other way round: the DB enum, the validator
 * and the inferred TS union cannot drift from what the client ships.
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

/**
 * Terminal run statuses — runs in any of these states are no longer
 * progressing. Used by event-ingestion ordering, SSE invalidation,
 * and any caller that needs to short-circuit polling.
 */
export const terminalRunStatusValues = ["success", "failed", "timeout", "cancelled"] as const;
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(terminalRunStatusValues);
export type TerminalRunStatus = (typeof terminalRunStatusValues)[number];

/**
 * Active (non-terminal) run statuses — the run is still progressing.
 * Mirror of {@link TERMINAL_RUN_STATUSES} for callers that need to gate
 * UI on "in flight" rather than "done". Derived from the same const
 * tuple pattern so adding a new status to {@link runStatusValues} forces
 * an explicit decision about which set it belongs to.
 */
export const activeRunStatusValues = ["pending", "running"] as const;
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(activeRunStatusValues);

/**
 * RunEvent types that mark a run as terminal — `run.success`, `run.failed`,
 * `run.timeout`, `run.cancelled`. Mirrors `terminalRunStatusValues` but for
 * the event-stream side of the boundary.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set(
  terminalRunStatusValues.map((status) => `run.${status}`),
);
