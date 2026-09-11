// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { $api, client, type components } from "../api/client";
import { splitPackageRef } from "../lib/package-paths";
import { useCurrentOrgId } from "./use-org";
import { useCurrentSpaceId } from "./use-current-space";
import { useOrgOnlyScope } from "./use-org-scope";
import type { ModelCost } from "@appstrate/core/module";
import type { ModelFormSubmission, ModelFormSubmitOutcome } from "../lib/model-form-payload";
import { submitModelForm } from "../lib/model-form-submit";
import { useCreateModelProviderCredential } from "./use-model-provider-credentials";
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

  // Spans the whole submission: the per-mutation flags drop between calls.
  const [submitPending, setSubmitPending] = useState(false);
  const isPending =
    submitPending || createModel.isPending || updateModel.isPending || createCredential.isPending;

  const submit = submitModelForm({
    writes: {
      createCredential: (body) => createCredential.mutateAsync({ body }),
      createModel: (body) => createModel.mutateAsync({ body }),
      updateModel: (id, body) => updateModel.mutateAsync({ params: { path: { id } }, body }),
    },
    editModelId: opts.editModel?.id ?? null,
    onSuccess: opts.onSuccess,
  });

  const onSubmit = async (data: ModelFormSubmission): Promise<ModelFormSubmitOutcome> => {
    setSubmitPending(true);
    try {
      return await submit(data);
    } finally {
      setSubmitPending(false);
    }
  };

  return { onSubmit, isPending };
}
