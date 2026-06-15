// SPDX-License-Identifier: Apache-2.0

/**
 * React Query hooks for the caller's member-scope integration pins
 * (`/api/me/integration-pins`). Replaces the previous `localStorage`-based
 * `use-agent-connection-picks` — the picker on the agent page now writes
 * a persisted DB row that the resolver sees on every run (cascade layer 4),
 * not an ephemeral browser-local value.
 *
 * One pin per (agent, integration, member-scope). The pin's connection
 * carries its own authKey; OAuth and api_key connections are
 * interchangeable at runtime.
 *
 * These are write-only mutations: the picker reads pin state off the
 * server-authoritative agent-resolution verdict (`member_pinned_connection_id`)
 * and refetches it itself after a pick, so the only invalidation needed here is
 * the typed `/api/me/integration-pins` path. Member pins are private per actor —
 * the API endpoint filters by the caller's user_id, so we never see other
 * users' pins client-side.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";

export interface UpsertMemberPinInput {
  agentPackageId: string;
  integrationId: string;
  connectionId: string;
}

export function useUpsertMemberIntegrationPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertMemberPinInput) => {
      const { data } = await client.PUT("/api/me/integration-pins", {
        body: {
          agent_package_id: input.agentPackageId,
          integration_package_id: input.integrationId,
          connection_id: input.connectionId,
        },
      });
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/integration-pins"] });
    },
  });
}

export interface DeleteMemberPinInput {
  agentPackageId: string;
  integrationId: string;
}

export function useDeleteMemberIntegrationPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: DeleteMemberPinInput) => {
      await client.DELETE("/api/me/integration-pins", {
        params: {
          query: {
            agent_package_id: input.agentPackageId,
            integration_package_id: input.integrationId,
          },
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/integration-pins"] });
    },
  });
}
