// SPDX-License-Identifier: Apache-2.0

/**
 * Run-status sets derived from `@appstrate/core/run-status`. MUST stay otherwise
 * import-free: the SPA reaches it, and any other import leaks the schema barrel.
 */

import {
  terminalRunStatusValues,
  activeRunStatusValues,
  type RunStatus,
} from "@appstrate/core/run-status";

/**
 * Terminal run statuses — used by event-ingestion ordering, SSE invalidation,
 * and any caller that needs to short-circuit polling.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(terminalRunStatusValues);

/** Mirror of {@link TERMINAL_RUN_STATUSES} for callers gating on "in flight". */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(activeRunStatusValues);

/**
 * RunEvent types that mark a run as terminal — `run.success`, `run.failed`,
 * `run.timeout`, `run.cancelled` — the event-stream side of the boundary.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set(
  terminalRunStatusValues.map((status) => `run.${status}`),
);
