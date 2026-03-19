import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { OrgProviderKeyInfo, TestResult } from "@appstrate/shared-types";

export function useProviderKeys() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["provider-keys", orgId],
    queryFn: () => api<{ keys: OrgProviderKeyInfo[] }>("/provider-keys").then((d) => d.keys),
    enabled: !!orgId,
  });
}

export function useCreateProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { label: string; api: string; baseUrl: string; apiKey: string }) => {
      return api<{ id: string }>("/provider-keys", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-keys"] });
    },
  });
}

export function useUpdateProviderKey() {
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
      return api(`/provider-keys/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-keys"] });
    },
  });
}

export function useDeleteProviderKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/provider-keys/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["provider-keys"] });
    },
  });
}

export function useTestProviderKey() {
  return useMutation({
    mutationFn: (id: string) => api<TestResult>(`/provider-keys/${id}/test`, { method: "POST" }),
  });
}

export function useTestProviderKeyInline() {
  return useMutation({
    mutationFn: (data: { api: string; baseUrl: string; apiKey?: string; existingKeyId?: string }) =>
      api<TestResult>("/provider-keys/test", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });
}
