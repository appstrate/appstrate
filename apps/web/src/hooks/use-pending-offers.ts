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

import { pendingOfferCount } from "../lib/catalogue-placement";
import { useLibrary } from "./use-library";

export function usePendingOfferCount(): number {
  const { data } = useLibrary();
  return data ? pendingOfferCount(Object.values(data.packages).flat()) : 0;
}
