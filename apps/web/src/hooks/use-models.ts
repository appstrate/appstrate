import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { OrgModelInfo } from "@appstrate/shared-types";

export function useModels() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["models", orgId],
    queryFn: () => api<{ models: OrgModelInfo[] }>("/models").then((d) => d.models),
    enabled: !!orgId,
  });
}

export function useCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      label: string;
      api: string;
      baseUrl: string;
      modelId: string;
      apiKey: string;
    }) => {
      return api<{ id: string }>("/models", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useUpdateModel() {
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
        modelId?: string;
        apiKey?: string;
        enabled?: boolean;
      };
    }) => {
      return api(`/models/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useDeleteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      return api(`/models/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useSetDefaultModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (modelId: string | null) => {
      return api("/models/default", {
        method: "PUT",
        body: JSON.stringify({ modelId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["models"] });
    },
  });
}

export function useFlowModel(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["flow-model", orgId, packageId],
    queryFn: () => api<{ modelId: string | null }>(`/flows/${packageId}/model`),
    enabled: !!orgId && !!packageId,
  });
}

export function useSetFlowModel(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (modelId: string | null) => {
      return api(`/flows/${packageId}/model`, {
        method: "PUT",
        body: JSON.stringify({ modelId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["flow-model"] });
      qc.invalidateQueries({ queryKey: ["packages", "flow"] });
    },
  });
}
