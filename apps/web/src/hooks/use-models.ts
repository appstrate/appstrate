// SPDX-License-Identifier: Apache-2.0

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { $api, client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentApplicationId } from "./use-current-application";
import { useOrgOnlyScope } from "./use-org-scope";
import type { ModelCost } from "@appstrate/core/module";
import type { ModelFormData } from "../components/model-form-modal";
import {
  useCreateModelProviderCredential,
  useModelProviderCredentials,
} from "./use-model-provider-credentials";

/** Wire shape from the OpenAPI spec (components.schemas.OrgModel). */
export type OrgModelInfo = components["schemas"]["OrgModel"];

export function useModels() {
  const scope = useOrgOnlyScope();
  return $api.useQuery(
    "get",
    "/api/models",
    { params: { header: scope.header } },
    { enabled: scope.enabled, select: (e) => e.data },
  );
}

/** openapi-react-query keys are [method, path, init] — invalidate the literal spec path. */
function useInvalidateModels() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["get", "/api/models"] });
  };
}

export function useCreateModel() {
  const invalidate = useInvalidateModels();
  return $api.useMutation("post", "/api/models", { onSuccess: invalidate });
}

export function useUpdateModel() {
  const invalidate = useInvalidateModels();
  return $api.useMutation("put", "/api/models/{id}", { onSuccess: invalidate });
}

export function useDeleteModel() {
  const invalidate = useInvalidateModels();
  return $api.useMutation("delete", "/api/models/{id}", { onSuccess: invalidate });
}

export function useSetDefaultModel() {
  const invalidate = useInvalidateModels();
  return $api.useMutation("put", "/api/models/default", { onSuccess: invalidate });
}

export function useTestModel() {
  return $api.useMutation("post", "/api/models/{id}/test");
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
  return $api.useQuery(
    "get",
    "/api/models/openrouter",
    { params: { query: { q: search || undefined } } },
    {
      enabled: search !== undefined,
      staleTime: 5 * 60 * 1000,
      gcTime: 10 * 60 * 1000,
      // The spec marks every item field optional — normalize to the
      // non-optional shape the model form has always consumed.
      select: (e): OpenRouterModel[] =>
        e.data.map((m) => ({
          id: m.id ?? "",
          name: m.name ?? m.id ?? "",
          contextWindow: m.contextWindow ?? null,
          maxTokens: m.maxTokens ?? null,
          input: m.input ?? [],
          reasoning: m.reasoning ?? false,
          cost:
            m.cost?.input !== undefined && m.cost.output !== undefined
              ? {
                  input: m.cost.input,
                  output: m.cost.output,
                  cacheRead: m.cost.cacheRead,
                  cacheWrite: m.cost.cacheWrite,
                }
              : null,
        })),
    },
  );
}

export function useAgentModel(packageId: string | undefined) {
  const orgId = useCurrentOrgId();
  const applicationId = useCurrentApplicationId();
  return useQuery({
    // Key kept legacy-shaped: invalidated by useSetAgentModel below and
    // app-switch resets.
    queryKey: ["agent-model", orgId, applicationId, packageId],
    queryFn: async () => {
      const { data } = await client.GET("/api/agents/{scope}/{name}/model", {
        params: { path: splitPackageRef(packageId!) },
      });
      return data!;
    },
    enabled: !!orgId && !!applicationId && !!packageId,
  });
}

export function useSetAgentModel(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (modelId: string | null) => {
      const { data } = await client.PUT("/api/agents/{scope}/{name}/model", {
        params: { path: splitPackageRef(packageId) },
        body: { modelId },
      });
      return data;
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
  // Kept warm so the modal's credential picker has data ready, but no
  // longer used here — the server now derives the credential's label
  // from the registry's `displayName` and dedupes against existing rows.
  useModelProviderCredentials();

  const isPending = createModel.isPending || updateModel.isPending || createCredential.isPending;

  const onSubmit = (data: ModelFormData) => {
    const createCredentialAndThen = (onKeyCreated: (keyId: string) => void) => {
      // Omit `label` — the server derives it from the provider's `displayName`
      // and dedupes against existing org credentials. Operator-side scripts
      // can pass `label` explicitly to override.
      createCredential.mutate(
        {
          body: {
            providerId: data.newCredential!.providerId,
            apiKey: data.newCredential!.apiKey,
            ...(data.newCredential!.baseUrlOverride
              ? { baseUrlOverride: data.newCredential!.baseUrlOverride }
              : {}),
          },
        },
        { onSuccess: (result) => onKeyCreated(result.id) },
      );
    };

    if (opts.editModel) {
      if (data.newCredential) {
        createCredentialAndThen((keyId) => {
          const { newCredential: _, ...modelData } = data;
          updateModel.mutate(
            {
              params: { path: { id: opts.editModel!.id } },
              body: { ...modelData, credentialId: keyId },
            },
            { onSuccess: opts.onSuccess },
          );
        });
      } else {
        updateModel.mutate(
          { params: { path: { id: opts.editModel.id } }, body: data },
          { onSuccess: opts.onSuccess },
        );
      }
    } else if (data.newCredential) {
      createCredentialAndThen((keyId) => {
        const { newCredential: _, ...modelData } = data;
        createModel.mutate(
          { body: { ...modelData, credentialId: keyId } },
          { onSuccess: opts.onSuccess },
        );
      });
    } else {
      createModel.mutate({ body: data }, { onSuccess: opts.onSuccess });
    }
  };

  return { onSubmit, isPending };
}
