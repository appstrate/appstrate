// SPDX-License-Identifier: Apache-2.0

/**
 * Shared model-facing contract + constants for the `wait_for_run` tool. Both
 * chat engines ship it (ai-sdk path: wait-for-run.ts, drives MCP
 * `invoke_operation`; Agent SDK path: claude-agent/local-tools.ts, rides the
 * platform `GET /api/runs/:id?wait=` long-poll). The transports + polling
 * strategies legitimately differ, but the description, input schema, terminal
 * statuses, timeout bounds, and the timeout hint must not drift — they live
 * here, consumed by both.
 */

import { z } from "zod";

/** Mirrors `terminalRunStatusValues` in packages/db/src/schema/enums.ts. */
export const TERMINAL_RUN_STATUSES = new Set(["success", "failed", "timeout", "cancelled"]);

export const WAIT_FOR_RUN_DEFAULT_TIMEOUT_S = 180;
export const WAIT_FOR_RUN_MAX_TIMEOUT_S = 600;

export const WAIT_FOR_RUN_DESCRIPTION =
  "Wait until an Appstrate run finishes and return its final status and result. " +
  "Always call this right after triggering a run (runInline, runAgent, …) instead of polling getRun yourself. " +
  "If it times out the run is still going: tell the user and offer to keep waiting (call it again with the same run_id).";

export const WAIT_FOR_RUN_TIMEOUT_HINT =
  "Run still in progress. Call wait_for_run again with the same run_id to keep waiting, or report the run_id to the user.";

/** Raw Zod shape (not a `z.object`) so it fits both `tool()` signatures. */
export const waitForRunInputShape = {
  run_id: z.string().describe("The run id returned when the run was triggered (e.g. run_…)."),
  timeout_seconds: z
    .number()
    .int()
    .min(5)
    .max(WAIT_FOR_RUN_MAX_TIMEOUT_S)
    .optional()
    .describe(
      `How long to wait before giving up (default ${WAIT_FOR_RUN_DEFAULT_TIMEOUT_S}s, max ${WAIT_FOR_RUN_MAX_TIMEOUT_S}s).`,
    ),
};
