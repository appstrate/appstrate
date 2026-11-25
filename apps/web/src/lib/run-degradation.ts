// SPDX-License-Identifier: Apache-2.0

import type { UnavailableToolReason } from "@appstrate/core/sidecar-types";

/** Safe-narrows `runs.metadata.degraded_integrations` (integration ids, stamped on a terminal 401 at refresh). */
export function parseDegradedIntegrations(metadata: unknown): string[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).degraded_integrations;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/** Every reason the platform stamps: a new one in core is a type error here until it is listed. */
const UNAVAILABLE_REASONS: Record<UnavailableToolReason, true> = {
  not_listed: true,
  hidden_tools: true,
  definition_not_approved: true,
  name_collision: true,
};

export interface UnavailableTool {
  integrationId: string;
  name: string;
  /** `null`: a reason this build does not know (a run stamped by a newer platform). */
  reason: UnavailableToolReason | null;
}

const isUnavailableReason = (value: unknown): value is UnavailableToolReason =>
  typeof value === "string" && Object.keys(UNAVAILABLE_REASONS).includes(value);

/** Safe-narrows `runs.metadata.unavailable_tools`: the tools a run's agent asked for that were not served. */
export function parseUnavailableTools(metadata: unknown): UnavailableTool[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>).unavailable_tools;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (item == null || typeof item !== "object") return [];
    const { integration_id, name, reason } = item as Record<string, unknown>;
    return typeof integration_id === "string" && typeof name === "string"
      ? [
          {
            integrationId: integration_id,
            name,
            reason: isUnavailableReason(reason) ? reason : null,
          },
        ]
      : [];
  });
}

/** Whether the run carries a warning its list row should flag. */
export function isRunDegraded(metadata: unknown): boolean {
  return (
    parseDegradedIntegrations(metadata).length > 0 || parseUnavailableTools(metadata).length > 0
  );
}
