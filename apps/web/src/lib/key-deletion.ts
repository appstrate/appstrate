// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { ModelProviderCredentialInfo } from "../hooks/use-model-provider-credentials";
import type { OrgModelInfo } from "../hooks/use-models";

/**
 * The confirmation of a key's deletion from Settings › Models. The server refuses an organization
 * key while any model references it, enabled or not (`credential_in_use`, the foreign key is
 * `ON DELETE RESTRICT`), so the confirmation names those models, says where they are deleted or
 * bound to another key, and offers only Annuler. A member's personal key serves no model of its
 * own: deleting it only leaves its holder without it.
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
