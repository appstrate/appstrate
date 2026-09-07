// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { $api, client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgOnlyScope } from "./use-org-scope";
import type { ModelCost } from "@appstrate/core/module";
import type {
  ModelFormData,
  ModelFormMultiData,
  ModelFormSubmission,
  ModelFormSubmitOutcome,
} from "../lib/model-form-payload";
import { toCreateModelBody } from "../lib/model-form-payload";
import {
  useCreateModelProviderCredential,
  useModelProviderCredentials,
} from "./use-model-provider-credentials";
import { agentModelKeys, packageKeys } from "../lib/query-keys";
import type { ModelGenerationSettings } from "@appstrate/core/model-generation";

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

/** A saved OAuth model test may rotate or terminally flag its backing credential. */
export async function invalidateModelConnectionTestQueries(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ["get", "/api/models"] }),
    qc.invalidateQueries({ queryKey: ["get", "/api/model-provider-credentials"] }),
  ]);
}

function useCreateModel() {
  const invalidate = useInvalidateModels();
  return $api.useMutation("post", "/api/models", { onSuccess: invalidate });
}

function useUpdateModel() {
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
  const qc = useQueryClient();
  return $api.useMutation("post", "/api/models/{id}/test", {
    onSuccess: () => invalidateModelConnectionTestQueries(qc),
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
  const spaceId = useCurrentSpaceId();
  return useQuery({
    // Key kept legacy-shaped: invalidated by useSetAgentModel below and
    // space-switch resets.
    queryKey: agentModelKeys.detail(orgId, spaceId, packageId),
    queryFn: async () => {
      const { data } = await client.GET("/api/agents/{scope}/{name}/model", {
        params: { path: splitPackageRef(packageId!) },
      });
      return data!;
    },
    enabled: !!orgId && !!spaceId && !!packageId,
  });
}

export function useSetAgentModel(packageId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      input:
        string | null | { modelId: string | null; generation?: ModelGenerationSettings | null },
    ) => {
      const body = typeof input === "object" && input !== null ? input : { modelId: input };
      const { data } = await client.PUT("/api/agents/{scope}/{name}/model", {
        params: { path: splitPackageRef(packageId) },
        body,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentModelKeys.all });
      qc.invalidateQueries({ queryKey: packageKeys.family("agents") });
    },
  });
}

/**
 * The create body for a key the form typed inline. `label` is omitted — the
 * server derives it from the provider's `displayName` (a custom endpoint is
 * named after its host) and dedupes against existing org credentials.
 */
function credentialBody(credential: NonNullable<ModelFormData["newCredential"]>) {
  return {
    providerId: credential.providerId,
    apiKey: credential.apiKey,
    ...(credential.baseUrlOverride ? { baseUrlOverride: credential.baseUrlOverride } : {}),
  };
}

/**
 * Handles ModelFormModal submission: creates provider key inline if needed,
 * then creates or updates the model — or, for a batch the detected-models list
 * checked, creates that one key and then one model per entry.
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

  // Spans the whole sequential batch: the per-mutation flags fall back to false
  // between two creates, which would re-enable the button mid-run.
  const [batchPending, setBatchPending] = useState(false);
  const isPending =
    batchPending || createModel.isPending || updateModel.isPending || createCredential.isPending;

  /**
   * One credential, then one `POST /api/models` per entry — there is no bulk
   * create. Each refusal is collected instead of aborting: the models around a
   * rejected id are still worth adding, and the caller re-offers the rest.
   */
  const submitBatch = async (data: ModelFormMultiData): Promise<ModelFormSubmitOutcome> => {
    setBatchPending(true);
    try {
      const credentialId = data.newCredential
        ? (await createCredential.mutateAsync({ body: credentialBody(data.newCredential) })).id
        : data.credentialId;
      const failedModelIds: string[] = [];
      for (const entry of data.models) {
        try {
          await createModel.mutateAsync({ body: { ...entry, credentialId } });
        } catch {
          failedModelIds.push(entry.modelId);
        }
      }
      if (failedModelIds.length === 0) opts.onSuccess();
      return { failedModelIds, credentialId };
    } catch {
      // The key itself was refused, so not one model could be created against it.
      return { failedModelIds: data.models.map((m) => m.modelId) };
    } finally {
      setBatchPending(false);
    }
  };

  const onSubmit = (data: ModelFormSubmission) => {
    if ("models" in data) return submitBatch(data);

    const createCredentialAndThen = (onKeyCreated: (keyId: string) => void) => {
      createCredential.mutate(
        { body: credentialBody(data.newCredential!) },
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
        createModel.mutate({ body: toCreateModelBody(data, keyId) }, { onSuccess: opts.onSuccess });
      });
    } else {
      createModel.mutate(
        { body: toCreateModelBody(data, data.credentialId) },
        { onSuccess: opts.onSuccess },
      );
    }
  };

  return { onSubmit, isPending };
}
