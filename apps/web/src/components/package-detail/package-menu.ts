// SPDX-License-Identifier: Apache-2.0

import type { MenuAction } from "../../lib/menu-action";

/** The groups of the package Actions menu, in the order they are drawn. */
const MENU_GROUPS = ["build", "execution", "export", "administration"] as const;
export type PackageMenuGroup = (typeof MENU_GROUPS)[number];

/** A deed of the package menu; `reason` greys it out and says why. */
export interface PackageMenuEntry extends MenuAction {
  group: PackageMenuGroup;
  reason?: string;
}

/** The visible entries by group, in menu order; a group with no visible entry is not drawn, and neither is its separator. */
export function menuSections(
  entries: readonly PackageMenuEntry[],
): Array<{ group: PackageMenuGroup; entries: PackageMenuEntry[] }> {
  const visible = entries.filter((entry) => !entry.hidden);
  return MENU_GROUPS.map((group) => ({
    group,
    entries: visible.filter((entry) => entry.group === group),
  })).filter((section) => section.entries.length > 0);
}
