// SPDX-License-Identifier: Apache-2.0

import type { PackageType } from "@appstrate/core/validation";
import type { CardItem } from "./package-card-item";
import { matchesSearch } from "./strings";

export const PACKAGE_ORIGINS = ["local", "system"] as const;
export const PACKAGE_ACTIVITIES = ["active", "inactive"] as const;

/** The rows the bar's search, origin and activity leave; an empty selection keeps all. */
export function narrowPackages(
  items: CardItem[],
  {
    query,
    origins,
    activities,
    holds,
  }: {
    query: string;
    origins: readonly (typeof PACKAGE_ORIGINS)[number][];
    /** Absent where the list cannot say what is running or used. */
    activities?: readonly (typeof PACKAGE_ACTIVITIES)[number][];
    holds: PackageType;
  },
): CardItem[] {
  return items.filter((item) => {
    // Name, description and keywords — everything a card puts on screen.
    if (!matchesSearch(query, [item.displayName, item.description, item.keywords])) return false;
    if (origins.length > 0 && !origins.includes(item.source ?? "local")) return false;
    if (!activities || activities.length !== 1) return true;
    const isActive = holds === "agent" ? Boolean(item.runningRuns) : Boolean(item.usedByAgents);
    return activities[0] === "active" ? isActive : !isActive;
  });
}
