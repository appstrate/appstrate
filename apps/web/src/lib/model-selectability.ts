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
