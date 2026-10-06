// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the caller's member-scope integration pins
 * (`/api/me/integration-pins`). Replaces the previous `localStorage`-based
 * `use-agent-connection-picks` — the picker on the agent page now writes
 * a persisted DB row that the resolver sees on every run (cascade layer 4),
 * not an ephemeral browser-local value.
 *
 * One pin per (agent, integration, member-scope), holding the WHOLE bound
 * SET: `PUT` replaces it, `DELETE` clears it. Each connection carries its own
 * authKey; OAuth and api_key connections are interchangeable at runtime.
 *
 * These are write-only mutations: the picker reads pin state off the
 * server-authoritative agent-resolution verdict (`member_pinned_connection_ids`)
 * and refetches it itself after a pick, so nothing is invalidated here. Member
 * pins are private per actor — the API endpoint filters by the caller's
 * user_id, so we never see other users' pins client-side.
 */

import { useMutation } from "@tanstack/react-query";
import { client } from "../api/client";

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
  return useMutation({
    mutationFn: async (input: DeleteMemberPinInput) => {
      await client.DELETE(MEMBER_PIN_PATH, {
        params: {
          path: {
            agentPackageId: input.agentPackageId,
            integrationPackageId: input.integrationId,
          },
        },
      });
    },
  });
}
