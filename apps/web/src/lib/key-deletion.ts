// SPDX-License-Identifier: Apache-2.0

/**
 * Deleting an organization key in one gesture, as a plan.
 *
 * The server refuses to delete a key while model rows reference it (`credential_in_use`, the
 * foreign key is `ON DELETE RESTRICT`). So the confirmation says what the deletion costs (the
 * models that lose their access), and the interface deletes those rows before the key. Unlike
 * the checklist, which only switches access off, these rows go for good: they point at the key.
 */

import type { OrgModelInfo } from "../hooks/use-models";
import { isModelSelectable, isMemberPaid } from "./model-selectability";
import { isSystemModel } from "./model-providers";

export interface KeyDeletionPlan {
  /** Every row that references the key, accessible or not: all of them must go first. */
  doomed: OrgModelInfo[];
  /** The ones the organization can use today: what the confirmation names. */
  accessible: OrgModelInfo[];
  /** The organization's default model when the key serves it, else `null`. */
  defaultModel: OrgModelInfo | null;
  /** The models that could take the default's place once the key is gone. */
  replacements: OrgModelInfo[];
}

export function planKeyDeletion(
  models: readonly OrgModelInfo[],
  credentialId: string,
): KeyDeletionPlan {
  const doomed = models.filter((m) => m.credentialId === credentialId && !isSystemModel(m));
  const gone = new Set(doomed.map((m) => m.id));
  const defaultModel = doomed.find((m) => m.is_default) ?? null;
  return {
    doomed,
    accessible: doomed.filter((m) => m.enabled),
    defaultModel,
    // A default each member pays for would leave every schedule without a model.
    replacements: defaultModel
      ? models.filter((m) => !gone.has(m.id) && isModelSelectable(m) && !isMemberPaid(m))
      : [],
  };
}
