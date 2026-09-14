// SPDX-License-Identifier: Apache-2.0

import type { CatalogueRowState } from "../components/catalogue-columns";
import type { CardItem } from "../pages/package-list";

/** Whether the row has anything to install here. */
export function canInstall(_item: CardItem, state: CatalogueRowState): boolean {
  return !state.everywhere && !state.activeHere;
}
