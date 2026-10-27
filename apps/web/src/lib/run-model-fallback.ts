// SPDX-License-Identifier: Apache-2.0

// The journal marker left when the chosen model no longer loaded and the org default
// served instead (`recordModelFallback`, `apps/api/src/services/run-context-builder.ts`).

const MODEL_FALLBACK_EVENT = "model_fallback";

export interface RunModelFallback {
  /** What was asked for: an organization model id, free text on the wire. */
  pinnedModelId: string;
  /** The label of the model that served the run. */
  model: string;
}

/** The first `model_fallback` row of a run's logs, or null (a run writes at most one). */
export function findModelFallback(
  logs: ReadonlyArray<{ event?: string | null; data?: unknown }> | undefined,
): RunModelFallback | null {
  const row = logs?.find((log) => log.event === MODEL_FALLBACK_EVENT);
  const data = row?.data;
  if (!data || typeof data !== "object") return null;
  const { pinnedModelId, model } = data as Record<string, unknown>;
  return typeof pinnedModelId === "string" && typeof model === "string"
    ? { pinnedModelId, model }
    : null;
}
