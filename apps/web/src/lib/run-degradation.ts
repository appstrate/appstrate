// SPDX-License-Identifier: Apache-2.0

/** Safe-narrows `runs.metadata.degraded_integrations` (integration ids, stamped on a terminal 401 at refresh). */
export function parseDegradedIntegrations(metadata: unknown): string[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).degraded_integrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export interface UnavailableTool {
  integrationId: string;
  name: string;
  reason: string;
}

/** Safe-narrows `runs.metadata.unavailable_tools`: the tools a run's agent asked for that were not served. */
export function parseUnavailableTools(metadata: unknown): UnavailableTool[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).unavailable_tools;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item == null || typeof item !== "object") return [];
    const { integration_id, name, reason } = item as Record<string, unknown>;
    return typeof integration_id === "string" && typeof name === "string"
      ? [{ integrationId: integration_id, name, reason: typeof reason === "string" ? reason : "" }]
      : [];
  });
}

/** Whether the run carries a warning its list row should flag. */
export function isRunDegraded(metadata: unknown): boolean {
  return (
    parseDegradedIntegrations(metadata).length > 0 || parseUnavailableTools(metadata).length > 0
  );
}
