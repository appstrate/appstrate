// SPDX-License-Identifier: Apache-2.0

import type { CatalogueRowState } from "../components/catalogue-columns";
import type { CardItem } from "../pages/package-list";

/**
 * Whether the row has anything to install here. A local MCP server has only
 * through the integration that runs it; without one there is nothing to do.
 */
export function canInstall(item: CardItem, state: CatalogueRowState): boolean {
  if (state.everywhere || state.activeHere) return false;
  return item.type !== "mcp-server" || Boolean(state.via);
}
