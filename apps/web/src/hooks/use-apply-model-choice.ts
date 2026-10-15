// SPDX-License-Identifier: Apache-2.0

import { $api, type paths } from "../api/client";
import { ApiError } from "../api/errors";
import { useInvalidatePaths } from "./use-invalidate-paths";
import { rowToEntry } from "../lib/model-form-payload";
import { refusalMessage } from "../lib/mutation-error";
import type { ModelChoicePlan } from "../lib/model-choice";

/** Where the models of a choice live: an organization key, or no key (each person's own). */
interface ModelChoiceTarget {
  credentialId: string | null;
  /** The service, named on a model left to personal keys. */
  providerId: string;
}

/** The key to mint first, in « Add a provider »: nothing else exists until the models are chosen. */
export interface NewProviderCredential {
  label: string;
  providerId: string;
  apiKey: string;
  baseUrlOverride?: string;
}

export type ModelChoiceBody =
  paths["/api/models/apply"]["post"]["requestBody"]["content"]["application/json"];

/**
 * The body of a choice: the key (an existing one, one to mint, or none), the models added, those
 * switched back on, the default, those switched off. The server applies it in that order, in one
 * transaction ({@link useApplyModelChoice}).
 */
export function modelChoiceBody(input: {
  plan: ModelChoicePlan;
  target: ModelChoiceTarget;
  newCredential?: NewProviderCredential;
}): ModelChoiceBody {
  const { plan, target, newCredential } = input;
  const credential: ModelChoiceBody["credential"] = newCredential
    ? {
        label: newCredential.label,
        providerId: newCredential.providerId,
        api_key: newCredential.apiKey,
        ...(newCredential.baseUrlOverride
          ? { base_url_override: newCredential.baseUrlOverride }
          : {}),
      }
    : target.credentialId
      ? { id: target.credentialId }
      : null;
  return {
    credential,
    ...(credential === null ? { providerId: target.providerId } : {}),
    add: plan.add.map(rowToEntry),
    enable: plan.grant.map((model) => model.id),
    disable: plan.withdraw.map((model) => model.id),
    ...(plan.defaultModelId ? { default_model_id: plan.defaultModelId } : {}),
  };
}

/** A refused choice: nothing was written. */
export interface ModelChoiceRefusal {
  /** The upstream ids the refusal names, one per refused entry. */
  failedModelIds: string[];
  /** What the server said of the first refusal it has a sentence for, else `null`. */
  refusal: string | null;
}

/**
 * The upstream ids a `400 validation_failed` names, read off its items' `field` (`add.<i>`,
 * `enable.<i>`, `disable.<i>`, `default_model_id`), and the first sentence among them. `null` for
 * any other failure, which is the choice's as a whole (the key refused, a permission).
 */
export function choiceRefusal(err: unknown, plan: ModelChoicePlan): ModelChoiceRefusal | null {
  if (!(err instanceof ApiError) || err.code !== "validation_failed") return null;
  const failedModelIds: string[] = [];
  let refusal: string | null = null;
  for (const item of err.errors ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const { field, code, message } = item as Record<string, unknown>;
    if (typeof field !== "string" || typeof code !== "string") continue;
    const [list, index] = field.split(".");
    const at = Number(index);
    const modelId =
      list === "add"
        ? plan.add[at]?.id
        : list === "enable"
          ? (plan.grant[at]?.modelId ?? undefined)
          : list === "disable"
            ? (plan.withdraw[at]?.modelId ?? undefined)
            : list === "default_model_id"
              ? (plan.defaultModelId ?? undefined)
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
  const invalidate = useInvalidatePaths("/api/models", "/api/model-provider-credentials");
  const mutation = $api.useMutation("post", "/api/models/apply", {
    meta: { errorHandledByCaller: true },
    onSuccess: invalidate,
  });
  const apply = (input: Parameters<typeof modelChoiceBody>[0]) =>
    mutation.mutateAsync({ body: modelChoiceBody(input) });
  const applyBody = (body: ModelChoiceBody) => mutation.mutateAsync({ body });
  return { apply, applyBody, isPending: mutation.isPending };
}
