// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";

export function useModelProviderCredentials() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["model-provider-credentials", orgId],
    queryFn: () => apiList<OrgModelProviderKeyInfo>("/model-provider-credentials"),
    enabled: !!orgId,
  });
}

/**
 * Catalog entry surfaced by `GET /api/model-provider-credentials/registry` —
 * the in-code `MODEL_PROVIDERS` registry on the API side, filtered by
 * `MODEL_PROVIDERS_DISABLED`. Used by the model picker so OAuth providers
 * (Codex, Claude Code) and any future entries don't need to be re-declared
 * client-side.
 */
export interface ProviderRegistryEntry {
  providerId: string;
  displayName: string;
  iconUrl: string | null;
  description: string | null;
  docsUrl: string | null;
  apiShape: string;
  defaultBaseUrl: string;
  baseUrlOverridable: boolean;
  authMode: "api_key" | "oauth2";
  models: {
    id: string;
    contextWindow: number;
    maxTokens: number | null;
    capabilities: readonly string[];
  }[];
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
      label: string;
      apiShape: string;
      baseUrl: string;
      apiKey: string;
    }) => {
      return api<{ id: string }>("/model-provider-credentials", {
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
      return api(`/model-provider-credentials/${id}`, {
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

export function deduplicateLabel(label: string, existingKeys: OrgModelProviderKeyInfo[]): string {
  const existingLabels = new Set(existingKeys.map((k) => k.label));
  if (!existingLabels.has(label)) return label;
  let counter = 2;
  while (existingLabels.has(`${label} (${counter})`)) counter++;
  return `${label} (${counter})`;
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
