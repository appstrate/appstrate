// SPDX-License-Identifier: Apache-2.0

import type { components } from "../api/client";

/** The org's compute month, as `GET /api/billing` projects it. */
type BillingCompute = components["schemas"]["EeBillingCompute"];

/**
 * Usage at which the page warns: the same 80 % the warning email fires at
 * (`QUOTA_WARNING_THRESHOLD` in `@appstrate/module-billing`). The bar itself turns yellow earlier,
 * at `USAGE_WARN` (70 %), like every other gauge: a colour cue first, then the explicit warning.
 */
const COMPUTE_WARNING_PERCENT = 80;

/** Minutes shown for a counter held in seconds. Whole minutes, rounded down: 59 s reads 0. */
export function usedComputeMinutes(compute: Pick<BillingCompute, "used_seconds">): number {
  return Math.floor(compute.used_seconds / 60);
}

/**
 * Where the org stands against its included minutes. `none` when the plan carries no compute
 * quota (nothing to gauge), `exhausted` exactly when a new run is refused (`usage_percent` is
 * floored server-side, so 100 means the counter reached the quota).
 */
export function computeState(
  compute: Pick<BillingCompute, "included_minutes" | "usage_percent">,
): "none" | "ok" | "warning" | "exhausted" {
  if (compute.included_minutes === null) return "none";
  if (compute.usage_percent >= 100) return "exhausted";
  if (compute.usage_percent >= COMPUTE_WARNING_PERCENT) return "warning";
  return "ok";
}
