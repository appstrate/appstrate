// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { dedupeLabel } from "@appstrate/core/dedupe-label";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import type {
  ModelProviderCredentialInfo,
  ProviderRegistryEntry,
  TestResult,
} from "@appstrate/shared-types";

export type { ProviderRegistryEntry } from "@appstrate/shared-types";

export function useModelProviderCredentials() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["model-provider-credentials", orgId],
    queryFn: () => apiList<ModelProviderCredentialInfo>("/model-provider-credentials"),
    enabled: !!orgId,
  });
}

export function useProvidersRegistry() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["model-provider-credentials", orgId, "registry"],
    queryFn: () => apiList<ProviderRegistryEntry>("/model-provider-credentials/registry"),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateModelProviderCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      /** Optional — server derives from registry `displayName` + org dedup when absent. */
      label?: string;
      providerId: string;
      apiKey: string;
      baseUrlOverride?: string | null;
    }) => {
      // Bare created credential resource (non-secret projection) (#657).
      return api<ModelProviderCredentialInfo>("/model-provider-credentials", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-credentials"] });
    },
  });
}

export function useUpdateModelProviderCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      // `apiShape` / `baseUrl` are pinned by `providerId` at create time and cannot
      // be mutated — delete and re-create to switch providers.
      data: {
        label?: string;
        apiKey?: string;
      };
    }) => {
      // Bare updated credential resource (non-secret projection) (#657).
      return api<ModelProviderCredentialInfo>(`/model-provider-credentials/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-credentials"] });
    },
  });
}

export function useDeleteModelProviderCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/model-provider-credentials/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-credentials"] });
    },
  });
}

export function useTestModelProviderCredential() {
  return useMutation({
    mutationFn: (id: string) =>
      api<TestResult>(`/model-provider-credentials/${id}/test`, { method: "POST" }),
  });
}

export interface RefreshModelsResponse {
  outcome: "ok" | "auth_failed" | "nothing_verified" | "no_candidates";
  probed_count: number;
  available_model_ids: string[] | null;
  models_verified_at: string | null;
}

/**
 * Empirical model discovery — probes which models the credential's
 * account/plan actually serves and persists them server-side.
 * Invalidates both the credentials list (badge) and the registry
 * (widened foreign-catalog model picker).
 */
export function useRefreshCredentialModels() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<RefreshModelsResponse>(`/model-provider-credentials/${id}/refresh-models`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-credentials"] });
    },
  });
}

export function deduplicateLabel(
  label: string,
  existingKeys: ModelProviderCredentialInfo[],
): string {
  return dedupeLabel(
    label,
    existingKeys.map((k) => k.label),
  );
}

export function useTestModelProviderCredentialInline() {
  return useMutation({
    mutationFn: (data: {
      apiShape: string;
      baseUrl: string;
      apiKey?: string;
      existingKeyId?: string;
    }) =>
      api<TestResult>("/model-provider-credentials/test", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}
