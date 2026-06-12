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
 * Query key includes the application id so two memberships in different
 * apps don't bleed pins through the cache. Member pins are also private
 * per actor — the API endpoint already filters by caller's user_id, so
 * we never see other users' pins client-side.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client } from "../api/client";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";

const KEY = (
  orgId: string | null | undefined,
  applicationId: string | null | undefined,
  agentPackageId: string | undefined,
) =>
  ["me-integration-pins", orgId ?? undefined, applicationId ?? undefined, agentPackageId] as const;

export interface UpsertMemberPinInput {
  agentPackageId: string;
  integrationId: string;
  connectionId: string;
}

export function useUpsertMemberIntegrationPin() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
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
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/integration-pins"] });
      // Legacy key — the picker still caches pins under this scheme.
      void qc.invalidateQueries({
        queryKey: KEY(orgId, applicationId, vars.agentPackageId),
      });
    },
  });
}

export interface DeleteMemberPinInput {
  agentPackageId: string;
  integrationId: string;
}

export function useDeleteMemberIntegrationPin() {
  const qc = useQueryClient();
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useMutation({
    mutationFn: async (input: DeleteMemberPinInput) => {
      await client.DELETE("/api/me/integration-pins", {
        params: {
          query: {
            agentPackageId: input.agentPackageId,
            integrationPackageId: input.integrationId,
          },
        },
      });
    },
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ["get", "/api/me/integration-pins"] });
      // Legacy key — the picker still caches pins under this scheme.
      void qc.invalidateQueries({
        queryKey: KEY(orgId, applicationId, vars.agentPackageId),
      });
    },
  });
}
