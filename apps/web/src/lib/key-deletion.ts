// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";
import { ApiError } from "../api/errors";
import { errorMessage } from "./mutation-error";

/** All referencing models count, including those hidden from the current model list. */
export function keyDeletionPrompt(
  credential: Pick<ModelProviderCredentialInfo, "label" | "owner_type" | "referencing_model_count">,
  t: TFunction,
  refusal: unknown = null,
  referenceCountVerified = true,
): { description: string; blocked: boolean } {
  const { label, referencing_model_count: count } = credential;
  if (count > 0) {
    return {
      description: t("credentials.deleteInUse", { ns: "settings", label, count }),
      blocked: true,
    };
  }
  const refusedInUse = refusal instanceof ApiError && refusal.code === "credential_in_use";
  if (refusal && (!refusedInUse || !referenceCountVerified)) {
    return {
      description: errorMessage(refusal),
      blocked: refusedInUse,
    };
  }
  return {
    description: t(
      credential.owner_type === "user"
        ? "credentials.deleteMemberConfirm"
        : "credentials.deleteConfirm",
      { ns: "settings", label },
    ),
    blocked: false,
  };
}
