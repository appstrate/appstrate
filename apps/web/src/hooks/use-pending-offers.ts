// SPDX-License-Identifier: Apache-2.0

/**
 * How many packages have been OFFERED to a space this caller reaches and
 * switched on by nobody yet.
 *
 * An offer is not an inbox item: `package_shares` places the package, and the
 * placement's state stays `none` until somebody activates it (RBAC spec §6.10).
 * So there is nothing to accept or decline — but there IS something nobody is
 * told about: the share route notifies a PERSON
 * (`createPackageShareNotification`, gated on `recipientUserId`) and says
 * nothing at all when the target is a team space. A package offered to the team
 * can therefore sit unseen forever.
 *
 * This count is the interface's own answer to that: the catalogue carries it,
 * so an offer is visible from the navigation whether or not anyone was
 * notified. It reads the library the catalogue already reads, so it costs no
 * request of its own. The counting rule lives in `lib/catalogue-placement`,
 * with the rest of the screen's reading of that model.
 */

import { pendingOfferCount, pendingShares } from "../lib/catalogue-placement";
import { CATALOGUE_SHARED_HREF, catalogueHref } from "../lib/catalogue-link";
import { useCatalogueLibrary } from "./use-library";

export function usePendingOfferCount(): number {
  const { data } = useCatalogueLibrary();
  return data ? pendingOfferCount(Object.values(data.packages).flat()) : 0;
}

/**
 * Where a "go to the shares" link lands — ONE rule for the navigation entry,
 * the bell and the alert, so no two of them disagree:
 *
 * - one share waiting → that package's sheet, where the decision is taken;
 * - several, whatever their kinds → "Partagés avec vous", one list of them all;
 * - none → `null`, and the caller links wherever it links by default.
 */
export function usePendingSharesHref(): string | null {
  const { data } = useCatalogueLibrary();
  if (!data) return null;
  const shares = pendingShares(Object.values(data.packages).flat());
  if (shares.length === 0) return null;
  if (shares.length > 1) return CATALOGUE_SHARED_HREF;
  const only = shares[0]!.pkg;
  return catalogueHref(only.type, { packageId: only.id });
}
