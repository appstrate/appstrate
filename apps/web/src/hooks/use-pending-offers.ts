// SPDX-License-Identifier: Apache-2.0

/** Packages offered to a space this caller reaches and activated by nobody yet (a share notifies no one, so the nav entry counts them). */

import { pendingShares } from "../lib/catalogue-placement";
import { catalogueHref } from "../lib/catalogue-link";
import { useCanReach } from "./use-can-reach";
import { useCatalogueLibrary, type LibraryPackageItem } from "./use-library";

/** How many shares wait and where the entry lands: one → that package's sheet; several → the first one's kind; none → `null`. */
export function pendingSharesEntry(
  shares: readonly { pkg: Pick<LibraryPackageItem, "id" | "type"> }[],
): {
  count: number;
  href: string | null;
} {
  const [only] = shares;
  if (!only) return { count: 0, href: null };
  const packageId = shares.length === 1 ? only.pkg.id : undefined;
  return { count: shares.length, href: catalogueHref(only.pkg.type, { packageId }) };
}

export function usePendingShares(): { count: number; href: string | null } {
  const enabled = useCanReach()("/catalogue");
  const { data } = useCatalogueLibrary({ enabled });
  return pendingSharesEntry(data ? pendingShares(Object.values(data.packages).flat()) : []);
}
