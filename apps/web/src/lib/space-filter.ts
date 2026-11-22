// SPDX-License-Identifier: Apache-2.0

/**
 * The space filter of the studio lists in « Tous les espaces »: team spaces by default, every
 * space one click away. Pure, so the URL rule and the row rule are tested without a router.
 */

interface FilterableSpace {
  id: string;
  personal: boolean;
}

export interface SpaceFilterState {
  /** Whether the reader is offered the choice: spaces of both kinds admit the list. */
  offered: boolean;
  /** The reader chose every space (`?space=all`). */
  all: boolean;
  /** The team spaces when narrowing, `undefined` when not (not offered, or every space chosen). */
  spaceIds: string[] | undefined;
}

/**
 * `raw` is the `space` URL parameter, user input: only `all` widens, anything else is absent.
 * With no team space or no personal space among `spaces` there is nothing to choose between, so
 * nothing is narrowed (a reader reaching only their personal space must not get empty lists).
 */
export function resolveSpaceFilter(
  raw: string | null,
  spaces: readonly FilterableSpace[],
): SpaceFilterState {
  const team = spaces.filter((space) => !space.personal).map((space) => space.id);
  const offered = team.length > 0 && spaces.some((space) => space.personal);
  const all = raw === "all";
  return { offered, all, spaceIds: offered && !all ? team : undefined };
}

/** Whether a row stays: always when not narrowing; else when one of its spaces is listed. */
export function inSpaces(
  rowSpaceIds: readonly string[] | undefined,
  spaceIds: readonly string[] | undefined,
): boolean {
  if (!spaceIds) return true;
  return !!rowSpaceIds?.some((id) => spaceIds.includes(id));
}

/** The admitting spaces the filter drops: what a narrowed list hides. Empty when not narrowing. */
export function hiddenSpaceIds(
  admitting: readonly { id: string }[],
  spaceIds: readonly string[] | undefined,
): string[] {
  if (!spaceIds) return [];
  return admitting.map((space) => space.id).filter((id) => !spaceIds.includes(id));
}

/** A list path widened to every space (`?space=all`) when `spanning`: a count across spaces opens the list it counted. */
export function withAllSpaces(path: string, spanning: boolean): string {
  return spanning ? `${path}?space=all` : path;
}
