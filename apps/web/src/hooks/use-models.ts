// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, apiList } from "../api";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import type { OrgModelInfo, TestResult } from "@appstrate/shared-types";
import type { ModelCost } from "@appstrate/core/module";
import type { ModelFormData } from "../components/model-form-modal";
import {
  useCreateModelProviderCredential,
  useModelProviderCredentials,
  useProvidersRegistry,
  deduplicateLabel,
} from "./use-model-provider-credentials";

export function useModels() {
  const orgId = useCurrentOrgId();
  return useQuery({
    queryKey: ["models", orgId],
    queryFn: () => apiList<OrgModelInfo>("/models"),
    enabled: !!orgId,
  });
}

export function useCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      label: string;
      modelId: string;
      credentialId: string;
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
        modelId?: string;
        credentialId?: string;
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
      apiList<OpenRouterModel>(
        `/models/openrouter${search ? `?q=${encodeURIComponent(search)}` : ""}`,
      ),
    enabled: search !== undefined,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

export function useAgentModel(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    queryKey: ["agent-model", orgId, applicationId, packageId],
    queryFn: () => api<{ modelId: string | null }>(`/agents/${packageId}/model`),
    enabled: !!orgId && !!applicationId && !!packageId,
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
  const createCredential = useCreateModelProviderCredential();
  const { data: credentials } = useModelProviderCredentials();
  const { data: registry } = useProvidersRegistry();

  const isPending = createModel.isPending || updateModel.isPending || createCredential.isPending;

  const onSubmit = (data: ModelFormData) => {
    const createCredentialAndThen = (onKeyCreated: (keyId: string) => void) => {
      // The form supplies the canonical providerId directly. We dedupe the
      // label against existing credentials, then forward apiKey + optional
      // baseUrlOverride untouched — `model-provider-credentials` rejects an
      // override on a non-overridable provider so we don't gate it here.
      const matched = (registry ?? []).find((p) => p.providerId === data.newCredential!.providerId);
      const label = deduplicateLabel(matched?.displayName ?? "Custom", credentials ?? []);
      createCredential.mutate(
        {
          label,
          providerId: data.newCredential!.providerId,
          apiKey: data.newCredential!.apiKey,
          ...(data.newCredential!.baseUrlOverride
            ? { baseUrlOverride: data.newCredential!.baseUrlOverride }
            : {}),
        },
        { onSuccess: (result) => onKeyCreated(result.id) },
      );
    };

    if (opts.editModel) {
      if (data.newCredential) {
        createCredentialAndThen((keyId) => {
          const { newCredential: _, ...modelData } = data;
          updateModel.mutate(
            { id: opts.editModel!.id, data: { ...modelData, credentialId: keyId } },
            { onSuccess: opts.onSuccess },
          );
        });
      } else {
        updateModel.mutate({ id: opts.editModel.id, data }, { onSuccess: opts.onSuccess });
      }
    } else if (data.newCredential) {
      createCredentialAndThen((keyId) => {
        const { newCredential: _, ...modelData } = data;
        createModel.mutate({ ...modelData, credentialId: keyId }, { onSuccess: opts.onSuccess });
      });
    } else {
      createModel.mutate(data, { onSuccess: opts.onSuccess });
    }
  };

  return { onSubmit, isPending };
}
