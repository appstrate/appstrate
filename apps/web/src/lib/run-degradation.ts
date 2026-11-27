// SPDX-License-Identifier: Apache-2.0

import type { UnavailableToolReason } from "@appstrate/core/sidecar-types";

/** The array stamped under `key` of a run's metadata; empty when absent or not an array. */
function metadataArray(metadata: unknown, key: string): unknown[] {
  if (metadata == null || typeof metadata !== "object") return [];
  const raw = (metadata as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw : [];
}

/** Safe-narrows `runs.metadata.degraded_integrations` (integration ids, stamped on a terminal 401 at refresh). */
export function parseDegradedIntegrations(metadata: unknown): string[] {
  const raw = metadataArray(metadata, "degraded_integrations");
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Every reason the platform stamps, with its label's i18n key (`agents` namespace): a new one in
 * core is a type error here until it is listed. The one list the parser and the card read.
 */
export const UNAVAILABLE_REASON_KEYS: Record<UnavailableToolReason, string> = {
  not_listed: "run.unavailableTools.reason.not_listed",
  hidden_tools: "run.unavailableTools.reason.hidden_tools",
  blocked_in_space: "run.unavailableTools.reason.blocked_in_space",
  definition_not_approved: "run.unavailableTools.reason.definition_not_approved",
  name_collision: "run.unavailableTools.reason.name_collision",
};

/** The label's key for a reason; `null` is one this build does not know. */
export const unavailableReasonKey = (reason: UnavailableToolReason | null): string =>
  reason === null ? "run.unavailableTools.reason.unknown" : UNAVAILABLE_REASON_KEYS[reason];

export interface UnavailableTool {
  integrationId: string;
  name: string;
  /** `null`: a reason this build does not know (a run stamped by a newer platform). */
  reason: UnavailableToolReason | null;
}

const isUnavailableReason = (value: unknown): value is UnavailableToolReason =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(UNAVAILABLE_REASON_KEYS, value);

/** Safe-narrows `runs.metadata.unavailable_tools`: the tools a run's agent asked for that were not served. */
export function parseUnavailableTools(metadata: unknown): UnavailableTool[] {
  const raw = metadataArray(metadata, "unavailable_tools");
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

export interface ScopeRequest {
  integrationId: string;
  connectionId: string;
  scopes: string[];
}

/** Safe-narrows `runs.metadata.scope_requests`: the scopes a server asked for that a connection of the run does not hold. */
export function parseScopeRequests(metadata: unknown): ScopeRequest[] {
  const raw = metadataArray(metadata, "scope_requests");
  return raw.flatMap((item) => {
    if (item == null || typeof item !== "object") return [];
    const { integration_id, connection_id, scopes } = item as Record<string, unknown>;
    if (typeof integration_id !== "string" || typeof connection_id !== "string") return [];
    const named = Array.isArray(scopes)
      ? scopes.filter((s): s is string => typeof s === "string")
      : [];
    return named.length > 0
      ? [{ integrationId: integration_id, connectionId: connection_id, scopes: named }]
      : [];
  });
}

/** Whether the run carries a warning its list row should flag. */
export function isRunDegraded(metadata: unknown): boolean {
  return (
    parseDegradedIntegrations(metadata).length > 0 ||
    parseUnavailableTools(metadata).length > 0 ||
    parseScopeRequests(metadata).length > 0
  );
}
