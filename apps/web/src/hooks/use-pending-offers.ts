// SPDX-License-Identifier: Apache-2.0

/** Packages offered to a space this caller reaches and activated by nobody yet (a share notifies no one, so the nav entry counts them). */

import { pendingShares } from "../lib/catalogue-placement";
import { CATALOGUE_SHARED_HREF, catalogueHref } from "../lib/catalogue-link";
import { useCanReach } from "./use-can-reach";
import { useCatalogueLibrary, type LibraryPackageItem } from "./use-library";

/** How many shares wait and where the entry lands: one → that package's sheet; several → "Partages en attente"; none → `null`. */
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
