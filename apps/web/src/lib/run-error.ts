// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { ModelErrorReason } from "@appstrate/core/model-error";
import type { components } from "../api/client";

type RunModelError = NonNullable<components["schemas"]["Run"]["model_error"]>;

/** The journal row the runner's terminal model refusal lands in (`appstrate.error`). */
const ADAPTER_ERROR_EVENT = "adapter_error";

/** Sentences for the structured reasons a refusal can name, read before the category's own. */
const RUN_ERROR_REASON_KEY: Record<ModelErrorReason, string> = {
  // Only a platform release clears it: the sentence offers no retry nor reconnection.
  runtime_version_too_old: "run.error.runtimeVersionTooOld",
};

/**
 * The structured reason (`data.error_reason`) of a run's `adapter_error` row, or null.
 * The column `model_error` keeps no reason: the journal is its only durable home. The
 * value is unvalidated JSONB, so a reason with no sentence here reads as none.
 */
export function findRunErrorReason(
  logs: ReadonlyArray<{ event?: string | null; data?: unknown }> | undefined,
): ModelErrorReason | null {
  for (const log of logs ?? []) {
    if (log.event !== ADAPTER_ERROR_EVENT || !log.data || typeof log.data !== "object") continue;
    const reason = (log.data as Record<string, unknown>).error_reason;
    if (
      typeof reason === "string" &&
      Object.prototype.hasOwnProperty.call(RUN_ERROR_REASON_KEY, reason)
    ) {
      return reason as ModelErrorReason;
    }
  }
  return null;
}

/**
 * The sentence a run's failure is shown as, chosen from what the server classified
 * (`status`, the journal's `errorReason`, `model_error`), never from the verbatim
 * `error` text, which is shown as written only when nothing classified it.
 */
export function runErrorText(
  run: { status: string; error?: string | null; model_error?: RunModelError | null },
  t: TFunction,
  errorReason: ModelErrorReason | null = null,
): string {
  // A `cancelled` run is only ever a member's cancellation (`POST /api/runs/{id}/cancel`).
  if (run.status === "cancelled") return t("run.cancelledByUser");
  if (errorReason) return t(RUN_ERROR_REASON_KEY[errorReason]);
  const failure = run.model_error;
  if (failure?.category === "credential_unavailable") return t("run.error.modelRefused");
  if (failure?.category === "rate_limited") return t("run.error.modelRateLimited");
  if (failure?.status != null && failure.message) {
    return t("run.error.model", { status: failure.status, message: failure.message });
  }
  return run.error ?? "";
}
