// SPDX-License-Identifier: Apache-2.0

/**
 * The integrations an agent still needs before the space that just switched it on
 * can run it. Activation cascades to nothing, and the run gate checks integrations
 * in the launching space (they carry credentials), while skills travel with the agent.
 */

import type { LibraryPackageItem } from "../hooks/use-library";

/** One integration an agent declares, and whether the target space runs it. */
export interface MissingDependency {
  id: string;
  name: string;
  /** False when the caller may not switch it on there — naming it is all we can do. */
  activatable: boolean;
}

export function missingIntegrations(
  declared: readonly { id: string }[],
  integrations: readonly LibraryPackageItem[],
  spaceId: string,
  mayActivate: (pkg: LibraryPackageItem) => boolean,
): MissingDependency[] {
  return declared.flatMap((entry) => {
    const row = integrations.find((candidate) => candidate.id === entry.id);
    // A system integration has a real switch like any other, but a package the
    // library does not carry is one this caller cannot see: naming it would
    // leak its existence, and the run gate will say it in its own words.
    if (!row) return [];
    const active = row.placements.some(
      (placement) => placement.space_id === spaceId && placement.state === "active",
    );
    if (active) return [];
    return [{ id: row.id, name: row.name || row.id, activatable: mayActivate(row) }];
  });
}
