// SPDX-License-Identifier: Apache-2.0

import { isModelSelectable } from "@appstrate/core/model-selectable";
import type { OrgModelInfo } from "../hooks/use-models";

/** A model pin the server cascade will skip: gone, or listed but not selectable. */
export function isModelPinUnavailable(
  orgModels: OrgModelInfo[],
  pinnedModelId: string | null | undefined,
): boolean {
  if (!pinnedModelId) return false;
  const pinned = orgModels.find((m) => m.id === pinnedModelId);
  return !pinned || !isModelSelectable(pinned);
}

/** A model each member serves with their own credential: never one a schedule may run on. */
export function isMemberPaid(model: OrgModelInfo): boolean {
  return model.binding === "user";
}
