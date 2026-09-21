// SPDX-License-Identifier: Apache-2.0

/**
 * What an agent still needs before the space that just switched it on can run
 * it.
 *
 * Activating a package activates THAT package: `activatePackage` cascades to
 * nothing. The run gate, however, asks for more, and it asks differently of the
 * two dependency families:
 *
 * - **Skills travel with the agent.** They are judged from the agent's HOME
 *   space, not from the space a run starts in (`placementAnchor`,
 *   `services/package-catalog.ts`): "a closure belongs to the package that
 *   declares it". An agent offered to another space keeps the skills its home
 *   placed beside it, so there is nothing to activate there.
 * - **Integrations do not.** They are judged in the space that launches
 *   (`listActiveIntegrationIds(..., spaceId)`), and a missing one refuses the
 *   run with `integration_not_active`. That asymmetry is deliberate: an
 *   integration carries CREDENTIALS, so the recipient runs it with theirs.
 *
 * So switching an agent on in a space where its integrations are not active
 * produces an agent that cannot start, and nothing said so. This computes
 * exactly what is missing, from data the catalogue already holds.
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
