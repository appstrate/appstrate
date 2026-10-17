// SPDX-License-Identifier: Apache-2.0

/**
 * Mutations on the caller's member-scope integration pins (`/api/me/integration-pins`): the
 * member's own choice of connections for an agent. One pin per (agent, integration, member-scope) holding the WHOLE
 * bound set: `PUT` replaces it, `DELETE` clears it. Write-only: the picker reads pin state off
 * the agent-resolution verdict (`member_pinned_connection_ids`) and refetches it itself.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { warnSchedulesDisabled } from "./use-schedules";

const MEMBER_PIN_PATH =
  "/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}";

interface UpsertMemberPinInput {
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
}

export function useUpsertMemberIntegrationPin() {
  return useMutation({
    mutationFn: async (input: UpsertMemberPinInput) => {
      const { data } = await client.PUT(MEMBER_PIN_PATH, {
        params: {
          path: {
            agentPackageId: input.agentPackageId,
            integrationPackageId: input.integrationId,
          },
        },
        body: { connection_ids: input.connectionIds },
      });
      return data;
    },
  });
}

interface DeleteMemberPinInput {
  agentPackageId: string;
  integrationId: string;
}

export function useDeleteMemberIntegrationPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteMemberPinInput) => {
      const { data } = await client.DELETE(MEMBER_PIN_PATH, {
        params: {
          path: {
            agentPackageId: input.agentPackageId,
            integrationPackageId: input.integrationId,
          },
        },
      });
      return data!;
    },
    onSuccess: ({ schedules_disabled_count: disabledCount }) => {
      if (disabledCount > 0) warnSchedulesDisabled(qc, disabledCount);
    },
  });
}
