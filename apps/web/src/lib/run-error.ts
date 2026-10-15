// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { components } from "../api/client";

type RunModelError = NonNullable<components["schemas"]["Run"]["model_error"]>;

/**
 * The sentence a run's failure is shown as, in a list or on the run itself. The run keeps its
 * `error` verbatim (a debugging surface); what is said is chosen from what the server
 * classified — `status` and `model_error` — never from that text, which is shown as written
 * when nothing classified it.
 */
export function runErrorText(
  run: { status: string; error?: string | null; model_error?: RunModelError | null },
  t: TFunction,
): string {
  // A `cancelled` run is only ever a member's cancellation (`POST /api/runs/{id}/cancel`).
  if (run.status === "cancelled") return t("run.cancelledByUser");
  const failure = run.model_error;
  if (failure?.category === "credential_unavailable") return t("run.error.modelRefused");
  if (failure?.category === "rate_limited") return t("run.error.modelRateLimited");
  if (failure?.status != null && failure.message) {
    return t("run.error.model", { status: failure.status, message: failure.message });
  }
  return run.error ?? "";
}

/** A cancelled run's error is a member's choice, not a failure: muted, never red. */
export function runErrorTone(run: { status: string }): string {
  return run.status === "cancelled" ? "text-muted-foreground" : "text-destructive";
}
