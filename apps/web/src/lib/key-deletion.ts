// SPDX-License-Identifier: Apache-2.0

import type { TFunction } from "i18next";
import type { OrgModelInfo } from "../hooks/use-models";

/**
 * The confirmation of an organization key's deletion. The server refuses it while any model
 * references the key, enabled or not (`credential_in_use`, the foreign key is
 * `ON DELETE RESTRICT`), so the confirmation names those models and offers only Annuler.
 */
export function keyDeletionPrompt(
  credential: { id: string; label: string },
  models: readonly OrgModelInfo[],
  t: TFunction,
): { description: string; blocked: boolean } {
  const using = models.filter((m) => m.credentialId === credential.id);
  if (using.length === 0) {
    return {
      description: t("credentials.deleteConfirm", { ns: "settings", label: credential.label }),
      blocked: false,
    };
  }
  return {
    description: t("credentials.deleteInUse", {
      ns: "settings",
      label: credential.label,
      count: using.length,
      models: using.map((m) => m.label).join(", "),
    }),
    blocked: true,
  };
}
