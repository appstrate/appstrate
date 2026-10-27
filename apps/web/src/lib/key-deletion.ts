// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";

/**
 * The server refuses an org key while any model references it, enabled or not (`credential_in_use`,
 * `ON DELETE RESTRICT`), so the prompt names those models and offers only Annuler. A member's
 * personal key serves no model of its own.
 */
export function keyDeletionPrompt(
  credential: Pick<ModelProviderCredentialInfo, "id" | "label" | "owner_type">,
  models: readonly OrgModelInfo[],
  t: TFunction,
): { description: string; blocked: boolean } {
  const { label } = credential;
  if (credential.owner_type === "user") {
    return {
      description: t("credentials.deleteMemberConfirm", { ns: "settings", label }),
      blocked: false,
    };
  }
  const using = models.filter((m) => m.credentialId === credential.id);
  if (using.length === 0) {
    return {
      description: t("credentials.deleteConfirm", { ns: "settings", label }),
      blocked: false,
    };
  }
  return {
    description: t("credentials.deleteInUse", {
      ns: "settings",
      label,
      count: using.length,
      models: using.map((m) => m.label).join(", "),
    }),
    blocked: true,
  };
}
