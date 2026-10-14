// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the caller's member-scope integration pins
 * (`/api/me/integration-pins`): the picker on the agent page writes a
 * persisted row that the resolver sees on every run (cascade layer 4).
 *
 * One pin per (agent, integration, member-scope), holding the WHOLE bound
 * SET: `PUT` replaces it, `DELETE` clears it. Each connection carries its own
 * authKey; OAuth and api_key connections are interchangeable at runtime.
 *
 * These are write-only mutations: the picker reads pin state off the
 * server-authoritative agent-resolution verdict (`member_pinned_connection_ids`)
 * and refetches it itself after a pick, so no pin read is invalidated here. Member
 * pins are private per actor — the API endpoint filters by the caller's
 * user_id, so we never see other users' pins client-side.
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
