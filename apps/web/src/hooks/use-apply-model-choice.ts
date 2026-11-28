// SPDX-License-Identifier: Apache-2.0

import { $api, type paths } from "../api/client";
import { ApiError } from "../api/errors";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { MODEL_CACHE_PATHS } from "../lib/query-keys";
import { rowToEntry } from "../lib/model-form-payload";
import { refusalMessage } from "../lib/mutation-error";
import type { ModelChoicePlan } from "../lib/model-choice";

export type ModelChoiceBody =
  paths["/api/models/apply"]["post"]["requestBody"]["content"]["application/json"];

/** The body of a choice (models added, switched back on, switched off) in a configuration; the server applies it in one transaction. */
export function modelChoiceBody(input: {
  plan: ModelChoicePlan;
  configId: string;
}): ModelChoiceBody {
  const { plan, configId } = input;
  return {
    config_id: configId,
    add: plan.add.map(rowToEntry),
    enable: plan.grant.map((model) => model.id),
    disable: plan.withdraw.map((model) => model.id),
  };
}

/** A refused choice: nothing was written. */
export interface ModelChoiceRefusal {
  /** The upstream ids the refusal names, one per refused entry. */
  failedModelIds: string[];
  /** What the server said of the first refusal it has a sentence for, else `null`. */
  refusal: string | null;
}

/** The upstream ids a `400 validation_failed` names (read off its items' `field`) and the first sentence among them; `null` for any failure of the choice as a whole. */
export function choiceRefusal(err: unknown, plan: ModelChoicePlan): ModelChoiceRefusal | null {
  if (!(err instanceof ApiError) || err.code !== "validation_failed") return null;
  const failedModelIds: string[] = [];
  let refusal: string | null = null;
  for (const item of err.errors ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const { field, code, message } = item as Record<string, unknown>;
    if (typeof field !== "string" || typeof code !== "string") continue;
    // `add.<i>` from the service, `add[<i>].<key>` from body validation.
    const [, list, index] = /^([a-z_]+)(?:[.[](\d+))?/.exec(field) ?? [];
    const at = Number(index);
    const modelId =
      list === "add"
        ? plan.add[at]?.id
        : list === "enable"
          ? (plan.grant[at]?.modelId ?? undefined)
          : list === "disable"
            ? (plan.withdraw[at]?.modelId ?? undefined)
            : undefined;
    if (!modelId) return null;
    failedModelIds.push(modelId);
    refusal ??= refusalMessage({
      code,
      field,
      ...(typeof message === "string" ? { message } : {}),
    });
  }
  return failedModelIds.length > 0 ? { failedModelIds, refusal } : null;
}

/** Applies a choice in one write: all of it, or — refused — none of it. */
export function useApplyModelChoice() {
  const invalidate = useInvalidatePaths(...MODEL_CACHE_PATHS);
  const mutation = $api.useMutation("post", "/api/models/apply", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
  const apply = (input: Parameters<typeof modelChoiceBody>[0]) =>
    mutation.mutateAsync({ body: modelChoiceBody(input) });
  return { apply, isPending: mutation.isPending };
}
