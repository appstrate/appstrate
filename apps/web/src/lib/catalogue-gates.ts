// SPDX-License-Identifier: Apache-2.0

// Pure verdicts on what a reader may DO to a package: controls read them so none offers what the server refuses.

import type { LibraryPackageItem } from "../hooks/use-library";
import { linkedSpacePath } from "./across-spaces";
import { packageDetailPath } from "./package-paths";

export type ActivationRefusal = "notPlaced" | "activate" | "deactivate";

export interface ActivationGate {
  allowed: boolean;
  /** `null` when allowed, and while the reader's standing in the space is unknown. */
  refusal: ActivationRefusal | null;
}

/** Spelled out so the locale test sees every key. */
export const ACTIVATION_REFUSAL_KEY: Record<ActivationRefusal, string> = {
  notPlaced: "library.cannotShareHere",
  activate: "library.cannotActivate",
  deactivate: "library.cannotDeactivate",
};

/**
 * The server's verdict (library row `activation`): the type's grant in the target space (a personal
 * space's owner needs none) and, where not placed yet, the share right in its home. No verdict
 * for a space refuses without blaming either half.
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

/**
 * The recipient's removal (`DELETE …/shares/{space}`): a placement someone else put in this space,
 * which the caller may switch off there (a personal space's owner always may) — the same verdict
 * as the switch, so no control offers what the server refuses.
 */
export function mayRemoveFromSpace(
  pkg: Pick<LibraryPackageItem, "placements" | "activation">,
  spaceId: string | null | undefined,
): boolean {
  return (
    !!spaceId &&
    pkg.placements.some(
      (placement) => placement.space_id === spaceId && placement.via === "shared",
    ) &&
    activationGate(pkg, spaceId, false).allowed
  );
}

export interface CatalogueDeeds {
  /** `home_writable`: moving is the same authority as editing. */
  moveHome: boolean;
  /** `home_shareable`: a verb of its own (RBAC spec §6.10). */
  share: boolean;
  /**
   * Spaces the package can be removed from: all its shared placements for a sharer; for its
   * recipient, the current space, or with none (« Tous les espaces ») every placement it may remove.
   */
  revokeFrom: string[];
}

export function catalogueDeeds(
  pkg: Pick<LibraryPackageItem, "home_writable" | "home_shareable" | "placements" | "activation">,
  currentSpaceId: string | null | undefined,
): CatalogueDeeds {
  const share = pkg.home_shareable === true;
  const shared = pkg.placements
    .filter((placement) => placement.via === "shared")
    .map((placement) => placement.space_id);
  return {
    moveHome: pkg.home_writable === true,
    share,
    revokeFrom: share
      ? shared
      : currentSpaceId
        ? mayRemoveFromSpace(pkg, currentSpaceId)
          ? [currentSpaceId]
          : []
        : shared.filter((spaceId) => mayRemoveFromSpace(pkg, spaceId)),
  };
}

/**
 * The space a package's own page opens in from the catalogue: the current one when it holds the
 * package; with none (« Tous les espaces »), a space the reader can enter where it runs, else
 * where it is placed switched off, else its home. `null`: nowhere the page could be read.
 */
interface PagePlacement {
  here: unknown;
  activeIn: readonly string[];
  inactiveIn: readonly string[];
  homeSpaceId: string | null;
}

export function pageSpace(
  placement: PagePlacement,
  enterable: readonly string[],
  currentSpaceId: string | null,
): string | null {
  if (currentSpaceId) return placement.here !== null ? currentSpaceId : null;
  const reached = (ids: readonly (string | null)[]) =>
    ids.find((id): id is string => !!id && enterable.includes(id)) ?? null;
  return (
    reached(placement.activeIn) ?? reached(placement.inactiveIn) ?? reached([placement.homeSpaceId])
  );
}

/**
 * The address of a package's own page from its catalogue sheet, entering the space `pageSpace`
 * picks when it is not the working one; a system package held nowhere opens as is. `null`: no
 * page to offer.
 */
export function catalogueOpenPage(
  pkg: Pick<LibraryPackageItem, "id" | "type" | "source">,
  placement: PagePlacement,
  enterable: readonly string[],
  currentSpaceId: string | null,
  workingSpaceId: string | null,
): string | null {
  const space = pageSpace(placement, enterable, currentSpaceId);
  if (space === null && pkg.source !== "system") return null;
  return linkedSpacePath(packageDetailPath(pkg.type, pkg.id), space ?? undefined, workingSpaceId);
}
