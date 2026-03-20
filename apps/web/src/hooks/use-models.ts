import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import type { OrgModelInfo, TestResult } from "@appstrate/shared-types";

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
      providerKeyId: string;
      input?: string[];
      contextWindow?: number;
      maxTokens?: number;
      reasoning?: boolean;
      cost?: ModelCost;
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
        providerKeyId?: string;
        enabled?: boolean;
        input?: string[] | null;
        contextWindow?: number | null;
        maxTokens?: number | null;
        reasoning?: boolean | null;
        cost?: ModelCost | null;
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

export function useTestModel() {
  return useMutation({
    mutationFn: (id: string) => api<TestResult>(`/models/${id}/test`, { method: "POST" }),
  });
}

/** Per-model pricing in $/M tokens. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextWindow: number | null;
  maxTokens: number | null;
  input: string[];
  reasoning: boolean;
  cost: ModelCost | null;
}

export function useOpenRouterModels(search: string | undefined) {
  return useQuery({
    queryKey: ["openrouter-models", search],
    queryFn: () =>
      api<{ models: OpenRouterModel[] }>(
        `/models/openrouter${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      ).then((d) => d.models),
    enabled: search !== undefined,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
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
