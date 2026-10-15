// SPDX-License-Identifier: Apache-2.0

/**
 * What the catalogue lets a reader DO to one package, as pure verdicts: every
 * switch, add button, bulk tick and row menu reads them, so a control can never
 * offer what the server refuses.
 */

import type { LibraryPackageItem } from "../hooks/use-library";

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
 * May the reader switch `pkg` on (`next: true`) or off in `spaceId`? The server's verdict, served
 * on the library row (`activation`): the type's grant in the target space (the owner of a
 * personal space needs none), and, where the package is not placed yet, the share right in its
 * home. A space the row has no verdict for refuses without blaming either half.
 */
export function activationGate(
  pkg: Pick<LibraryPackageItem, "activation">,
  spaceId: string,
  next: boolean,
): ActivationGate {
  const cell = pkg.activation.find((entry) => entry.spaceId === spaceId);
  if (!cell) return { allowed: false, refusal: null };
  const verdict = next ? cell.activate : cell.deactivate;
  if (verdict === "allowed") return { allowed: true, refusal: null };
  if (verdict === "not_shareable") return { allowed: false, refusal: "notPlaced" };
  return { allowed: false, refusal: next ? "activate" : "deactivate" };
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
