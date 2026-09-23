// SPDX-License-Identifier: Apache-2.0

/**
 * Run-status sets, derived from the canonical tuples in
 * `@appstrate/core/run-status` (same pattern as `orgRoleValues = ORG_ROLES`).
 *
 * **This module MUST stay import-free** apart from that one import-free core
 * module. It is the one piece of the DB package the browser bundle is allowed
 * to reach: `@appstrate/shared-types` re-exports these values to the SPA, and
 * any other import (drizzle-orm, zod, another schema file) would drag the
 * schema barrel — and its table/column names — into a public asset.
 *
 * The Drizzle `pgEnum` and the Zod validator (`schema/enums.ts`) derive from
 * the same tuples, so the DB enum, the validator and the client cannot drift.
 */

import {
  runStatusValues,
  terminalRunStatusValues,
  activeRunStatusValues,
  type RunStatus,
  type TerminalRunStatus,
} from "@appstrate/core/run-status";

export { runStatusValues, terminalRunStatusValues, activeRunStatusValues };
export type { RunStatus, TerminalRunStatus };

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
