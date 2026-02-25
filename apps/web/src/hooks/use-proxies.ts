import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { OrgProxyInfo } from "@appstrate/shared-types";

export function useProxies() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["proxies", orgId],
    queryFn: () => api<{ proxies: OrgProxyInfo[] }>("/proxies").then((d) => d.proxies),
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

export function useFlowProxy(flowId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flow-proxy", orgId, flowId],
    queryFn: () =>
      api<{ proxyId: string | null; proxyLabel?: string; resolved: boolean }>(
        `/flows/${flowId}/proxy`,
      ),
    enabled: !!orgId && !!flowId,
  });
}

export function useSetFlowProxy(flowId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (proxyId: string | null) => {
      return api(`/flows/${flowId}/proxy`, {
        method: "PUT",
        body: JSON.stringify({ proxyId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-proxy"] });
      qc.invalidateQueries({ queryKey: ["flow"] });
    },
  });
}
