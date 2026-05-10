// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { OrgModelProviderKeyInfo, TestResult } from "@appstrate/shared-types";

export function useModelProviderKeys() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["model-provider-keys", orgId],
    queryFn: () => apiList<OrgModelProviderKeyInfo>("/model-provider-keys"),
    enabled: !!orgId,
  });
}

export function useCreateModelProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { label: string; api: string; baseUrl: string; apiKey: string }) => {
      return api<{ id: string }>("/model-provider-keys", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-keys"] });
    },
  });
}

export function useUpdateModelProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: {
        label?: string;
        api?: string;
        baseUrl?: string;
        apiKey?: string;
      };
    }) => {
      return api(`/model-provider-keys/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-keys"] });
    },
  });
}

export function useDeleteModelProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/model-provider-keys/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["model-provider-keys"] });
    },
  });
}

export function useTestModelProviderKey() {
  return useMutation({
    mutationFn: (id: string) =>
      api<TestResult>(`/model-provider-keys/${id}/test`, { method: "POST" }),
  });
}

export function deduplicateLabel(label: string, existingKeys: OrgModelProviderKeyInfo[]): string {
  const existingLabels = new Set(existingKeys.map((k) => k.label));
  if (!existingLabels.has(label)) return label;
  let counter = 2;
  while (existingLabels.has(`${label} (${counter})`)) counter++;
  return `${label} (${counter})`;
}

export function useTestModelProviderKeyInline() {
  return useMutation({
    mutationFn: (data: { api: string; baseUrl: string; apiKey?: string; existingKeyId?: string }) =>
      api<TestResult>("/model-provider-keys/test", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}
