// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { OrgProxyInfo, TestResult } from "@appstrate/shared-types";

export function useProxies() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["proxies", orgId],
    queryFn: () => apiList<OrgProxyInfo>("/proxies"),
    enabled: !!orgId,
  });
}

export function useCreateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: { label: string; url: string }) => {
      return api<{ id: string }>("/proxies", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useUpdateProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: string;
      data: { label?: string; url?: string; enabled?: boolean };
    }) => {
      return api(`/proxies/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useDeleteProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/proxies/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useSetDefaultProxy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proxyId: string | null) => {
      return api("/proxies/default", {
        method: "PUT",
        body: JSON.stringify({ proxyId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proxies"] });
    },
  });
}

export function useTestProxy() {
  return useMutation({
    mutationFn: (id: string) => api<TestResult>(`/proxies/${id}/test`, { method: "POST" }),
  });
}

export function useAgentProxy(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-proxy", orgId, applicationId, packageId],
    queryFn: () =>
      api<{ proxyId: string | null; proxyLabel?: string; resolved: boolean }>(
        `/agents/${packageId}/proxy`,
      ),
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}

export function useSetAgentProxy(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proxyId: string | null) => {
      return api(`/agents/${packageId}/proxy`, {
        method: "PUT",
        body: JSON.stringify({ proxyId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-proxy"] });
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
    },
  });
}
