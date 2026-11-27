// SPDX-License-Identifier: Apache-2.0

import type { OrgOfferMode } from "../hooks/use-library";

/** What the offer row shows: no offer, or one of the two modes. */
export type OfferChoice = "none" | OrgOfferMode;

/**
 * What choosing `next` does from `current`: nothing, a confirmation first (withdrawing, or going
 * from « activé par défaut » to « disponible », both of which take the package away from spaces
 * that have not placed it themselves), or the write itself.
 */
export function offerChangeStep(
  current: OfferChoice,
  next: OfferChoice,
): "none" | "confirm_withdraw" | "confirm_available" | "apply" {
  if (next === current) return "none";
  if (next === "none") return "confirm_withdraw";
  if (next === "available" && current === "on_by_default") return "confirm_available";
  return "apply";
}
