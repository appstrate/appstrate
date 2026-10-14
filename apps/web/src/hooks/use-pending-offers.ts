// SPDX-License-Identifier: Apache-2.0

/**
 * The packages OFFERED to a space this caller reaches and switched on by nobody
 * yet, as the catalogue's navigation entry shows them.
 *
 * An offer is not an inbox item: `package_shares` places the package, and the
 * placement's state stays `none` until somebody activates it (RBAC spec §6.10).
 * So there is nothing to accept or decline — but there IS something nobody is
 * told about: the share route notifies a PERSON
 * (`createPackageShareNotification`, gated on `recipientUserId`) and says
 * nothing at all when the target is a team space. A package offered to the team
 * can therefore sit unseen forever.
 *
 * The count is the interface's own answer to that: an offer is visible from the
 * navigation whether or not anyone was notified. It reads the library the
 * catalogue reads, and only for a caller the catalogue opens to. The counting
 * rule lives in `lib/catalogue-placement`, with the rest of the screen's
 * reading of that model.
 */

import { pendingShares } from "../lib/catalogue-placement";
import { CATALOGUE_SHARED_HREF, catalogueHref } from "../lib/catalogue-link";
import { useCanReach } from "./use-can-reach";
import { useCatalogueLibrary, type LibraryPackageItem } from "./use-library";

/**
 * How many shares wait, and where the entry lands with them:
 *
 * - one share waiting → that package's sheet, where the decision is taken;
 * - several, whatever their kinds → "Partages en attente", one list of them all;
 * - none → `null`, and the entry links wherever it links by default.
 */
export function pendingSharesEntry(
  shares: readonly { pkg: Pick<LibraryPackageItem, "id" | "type"> }[],
): {
  count: number;
  href: string | null;
} {
  const [only] = shares;
  if (!only) return { count: 0, href: null };
  if (shares.length > 1) return { count: shares.length, href: CATALOGUE_SHARED_HREF };
  return { count: 1, href: catalogueHref(only.pkg.type, { packageId: only.pkg.id }) };
}

export function usePendingShares(): { count: number; href: string | null } {
  const enabled = useCanReach()("/catalogue");
  const { data } = useCatalogueLibrary({ enabled });
  return pendingSharesEntry(data ? pendingShares(Object.values(data.packages).flat()) : []);
}
