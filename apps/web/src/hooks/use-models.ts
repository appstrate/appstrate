// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { OrgModelInfo, TestResult, ModelCost } from "@appstrate/shared-types";
import type { ModelFormData } from "../components/model-form-modal";
import { useCreateProviderKey } from "./use-provider-keys";
import { findProviderByApiAndBaseUrl } from "../lib/model-presets";

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

export type { ModelCost };

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

export function useAgentModel(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const appId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-model", orgId, appId, packageId],
    queryFn: () => api<{ modelId: string | null }>(`/agents/${packageId}/model`),
    enabled: !!orgId && !!appId && !!packageId,
  });
}

export function useSetAgentModel(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (modelId: string | null) => {
      return api(`/agents/${packageId}/model`, {
        method: "PUT",
        body: JSON.stringify({ modelId }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["agent-model"] });
      qc.invalidateQueries({ queryKey: ["packages", "agent"] });
    },
  });
}

/**
 * Handles ModelFormModal submission: creates provider key inline if needed,
 * then creates or updates the model.
 */
export function useModelFormHandler(opts: {
  editModel?: OrgModelInfo | null;
  onSuccess: () => void;
}) {
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();
  const createPk = useCreateProviderKey();

  const isPending = createModel.isPending || updateModel.isPending || createPk.isPending;

  const onSubmit = (data: ModelFormData) => {
    if (opts.editModel) {
      updateModel.mutate({ id: opts.editModel.id, data }, { onSuccess: opts.onSuccess });
    } else if (data.newProviderKey) {
      const provider = findProviderByApiAndBaseUrl(data.api, data.baseUrl);
      const providerLabel = provider?.label ?? "Custom";
      createPk.mutate(
        {
          label: providerLabel,
          api: data.api,
          baseUrl: data.baseUrl,
          apiKey: data.newProviderKey.apiKey,
        },
        {
          onSuccess: (result) => {
            const { newProviderKey: _, ...modelData } = data;
            createModel.mutate(
              { ...modelData, providerKeyId: result.id },
              { onSuccess: opts.onSuccess },
            );
          },
        },
      );
    } else {
      createModel.mutate(data, { onSuccess: opts.onSuccess });
    }
  };

  return { onSubmit, isPending };
}
