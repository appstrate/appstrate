// SPDX-License-Identifier: Apache-2.0

/**
 * What the catalogue lets a reader DO to one package, as pure verdicts: every
 * switch, add button, bulk tick and row menu reads them, so a control can never
 * offer what the server refuses.
 */

import type { LibraryPackageItem } from "../hooks/use-library";
import { maySetPackageActive, type SpaceGrant } from "./package-permissions";

/** Why a switch cannot go the way it would go — each one its own sentence. */
export type ActivationRefusal = "notPlaced" | "activate" | "deactivate";

export interface ActivationGate {
  allowed: boolean;
  /** `null` when allowed, and while the reader's standing in the space is unknown. */
  refusal: ActivationRefusal | null;
}

/** The sentence each refusal carries, spelled out so the locale test sees every key. */
export const ACTIVATION_REFUSAL_KEY: Record<ActivationRefusal, string> = {
  notPlaced: "library.cannotShareHere",
  activate: "library.cannotActivate",
  deactivate: "library.cannotDeactivate",
};

/**
 * May the reader switch `pkg` on (`next: true`) or off in `spaceId`?
 *
 * Two halves: the type's grant in the TARGET space (`maySetPackageActive`, the
 * owner of a personal space included), and, where the package is not placed
 * yet, the SHARE right in its home (`home_shareable`), since the route shares it
 * there before it activates it (`routes/spaces.ts`). A grant not loaded yet
 * (`undefined`) refuses without blaming either half.
 */
export function activationGate(
  pkg: Pick<LibraryPackageItem, "type" | "placements" | "home_shareable">,
  spaceId: string,
  grant: SpaceGrant | undefined,
  next: boolean,
): ActivationGate {
  if (!grant) return { allowed: false, refusal: null };
  const placed = pkg.placements.some((placement) => placement.space_id === spaceId);
  if (!placed && pkg.home_shareable !== true) return { allowed: false, refusal: "notPlaced" };
  if (!maySetPackageActive(grant, pkg.type, next)) {
    return { allowed: false, refusal: next ? "activate" : "deactivate" };
  }
  return { allowed: true, refusal: null };
}

/** The deeds on the package itself, behind a row's "…" and the sheet's Actions menu. */
export interface CatalogueDeeds {
  /** `home_writable`: moving a package is the same authority as editing it. */
  moveHome: boolean;
  /** `home_shareable`: a verb of its own on the home space (RBAC spec §6.10). */
  share: boolean;
  /** Spaces whose share the reader may withdraw, with the activation it backs. */
  revokeFrom: string[];
}

export function catalogueDeeds(
  pkg: Pick<LibraryPackageItem, "home_writable" | "home_shareable" | "placements">,
): CatalogueDeeds {
  const share = pkg.home_shareable === true;
  return {
    moveHome: pkg.home_writable === true,
    share,
    revokeFrom: share
      ? pkg.placements
          .filter((placement) => placement.via === "shared")
          .map((placement) => placement.space_id)
      : [],
  };
}
