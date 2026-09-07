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

/** `label` is omitted: the server derives and dedupes one. */
function credentialBody(credential: NonNullable<ModelFormData["newCredential"]>) {
  return {
    providerId: credential.providerId,
    apiKey: credential.apiKey,
    ...(credential.baseUrlOverride ? { baseUrlOverride: credential.baseUrlOverride } : {}),
  };
}

/**
 * ModelFormModal submission: the inline key first if any, then one create or
 * update — or, for a batch, one create per entry against that one key.
 */
export function useModelFormHandler(opts: {
  editModel?: OrgModelInfo | null;
  onSuccess: () => void;
}) {
  const createModel = useCreateModel();
  const updateModel = useUpdateModel();
  const createCredential = useCreateModelProviderCredential();
  // Kept warm for the modal's credential picker.
  useModelProviderCredentials();

  // Spans the whole submission: the per-mutation flags drop between calls.
  const [submitPending, setSubmitPending] = useState(false);
  const isPending =
    submitPending || createModel.isPending || updateModel.isPending || createCredential.isPending;

  /** The credential the model(s) bind to: the picked one, or the typed key created first. */
  const bindCredential = async (data: ModelFormSubmission): Promise<string> =>
    data.newCredential
      ? (await createCredential.mutateAsync({ body: credentialBody(data.newCredential) })).id
      : data.credentialId;

  /** No bulk create: one POST per entry, refusals collected rather than aborting. */
  const submitBatch = async (data: ModelFormMultiData): Promise<ModelFormSubmitOutcome> => {
    setSubmitPending(true);
    try {
      const credentialId = await bindCredential(data);
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
      // The key itself was refused.
      return { failedModelIds: data.models.map((m) => m.modelId) };
    } finally {
      setSubmitPending(false);
    }
  };

  /** A refusal (of the key or the model) is reported the way a batch reports its own. */
  const submitOne = async (data: ModelFormData): Promise<ModelFormSubmitOutcome> => {
    setSubmitPending(true);
    try {
      const credentialId = await bindCredential(data);
      if (opts.editModel) {
        const { newCredential: _, ...modelData } = data;
        await updateModel.mutateAsync({
          params: { path: { id: opts.editModel.id } },
          body: { ...modelData, credentialId },
        });
      } else {
        await createModel.mutateAsync({ body: toCreateModelBody(data, credentialId) });
      }
      opts.onSuccess();
      return { failedModelIds: [] };
    } catch {
      return { failedModelIds: [data.modelId] };
    } finally {
      setSubmitPending(false);
    }
  };

  const onSubmit = (data: ModelFormSubmission) =>
    "models" in data ? submitBatch(data) : submitOne(data);

  return { onSubmit, isPending };
}
