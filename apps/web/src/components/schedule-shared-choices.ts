// SPDX-License-Identifier: Apache-2.0

import { MAX_CONNECTIONS_PER_INTEGRATION } from "@appstrate/core/integration";
import type { components } from "../api/schema";
import type { ActorValue } from "../lib/schedule-payload";
import type { ConnectionChoice } from "../lib/connection-choice";
import { describeResolution } from "./integration-connect/integration-run-readiness";

export type Readiness = components["schemas"]["AgentConnectionReadiness"]["integrations"][number];
export type CandidateGroup = {
  integrationId: string;
  candidates: Pick<
    ConnectionChoice["candidates"][number],
    "id" | "account_id" | "needs_reconnection" | "label" | "owned_by_actor"
  >[];
  max?: number;
  allowNone?: boolean;
};

/** Only a connection shared here is a portable choice for another member. Their own
 * pins and private connections are resolved by the server when this schedule fires. */
export function sharedChoices(
  entries: readonly Readiness[],
  actor: ActorValue,
  picks: Readonly<Record<string, string[]>>,
): CandidateGroup[] {
  return entries.flatMap(
    ({
      integration_package_id: integrationId,
      resolution,
      inert,
      connection_required,
      required,
    }) => {
      const { lockedBy, lockedConnectionIds, additionsAllowed } = describeResolution(resolution);
      const inactive =
        resolution.error_code === "integration_not_active" ||
        resolution.warning?.code === "integration_not_active";
      const editable =
        connection_required && !inert && !inactive && (!lockedBy || additionsAllowed);
      const candidates = editable
        ? resolution.candidates
            .filter(
              (c) =>
                c.shared_here &&
                !lockedConnectionIds.includes(c.id) &&
                !c.needs_reconnection &&
                c.missing_scopes.length === 0,
            )
            .map((c) => ({
              id: c.id,
              account_id: c.account_id,
              needs_reconnection: c.needs_reconnection,
              label: c.owner_name ? `${c.label} — ${c.owner_name}` : c.label,
              owned_by_actor:
                c.owner_user_id === actor.userId || c.owner_end_user_id === actor.endUserId,
            }))
        : [];
      // An unchanged private/stale pick can be kept. Clear it explicitly before choosing a replacement.
      if (picks[integrationId]?.some((id) => !candidates.some((c) => c.id === id))) return [];
      return [
        {
          integrationId,
          candidates,
          max: MAX_CONNECTIONS_PER_INTEGRATION - lockedConnectionIds.length,
          allowNone: editable && !required && !lockedBy,
        },
      ];
    },
  );
}
