// SPDX-License-Identifier: Apache-2.0

/**
 * The packages offered to a space this caller reaches and activated by nobody yet.
 * A share to a team space notifies no one, so the catalogue's navigation entry
 * counts these offers itself.
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
