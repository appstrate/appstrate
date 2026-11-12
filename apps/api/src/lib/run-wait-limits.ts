// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Ceiling of `GET /api/runs/{id}?wait=`, in seconds, below typical 60 s proxy idle timeouts.
 * Larger values are clamped, not rejected. A leaf, so the OpenAPI spec can interpolate it.
 */
export const MAX_WAIT_SECONDS = 55;

/**
 * The one `wait` rule shared by `GET /api/runs/{id}?wait=` and the MCP `run_and_wait`
 * tool: `"true"` → `maxSeconds`, `"false"` → `0`, a non-negative integer number of
 * seconds → itself clamped to `maxSeconds`. Anything else (negative, fractional,
 * non-numeric) → `null`, which each caller refuses. Each caller passes its own ceiling.
 */
export function parseWaitSeconds(raw: string, maxSeconds: number): number | null {
  const parsed = z
    .union([
      z.literal("true").transform(() => maxSeconds),
      z.literal("false").transform(() => 0),
      z.coerce
        .number()
        .int()
        .min(0)
        .transform((n) => Math.min(n, maxSeconds)),
    ])
    .safeParse(raw);
  return parsed.success ? parsed.data : null;
}
