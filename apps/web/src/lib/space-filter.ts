// SPDX-License-Identifier: Apache-2.0

/**
 * The space filter of the studio lists in « Tous les espaces »: team spaces by default, every
 * space one click away. Pure, so the URL rule and the row rule are tested without a router.
 */

/** The kinds of space the run list narrows to (`space_kind`). */
export type SpaceKind = "team" | "personal";

/** The `space` URL parameter of the studio lists. */
export const SPACE_PARAM = "space";

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

/**
 * Whether an empty list says « nothing in team spaces » (and offers every space): only when the
 * reader filtered nothing, the default narrows, and the narrowing hides something. Otherwise the
 * page's own empty state speaks: a list empty in every space must still offer its create button.
 * `hiddenCount` is what the filter drops (rows, or runs of personal spaces).
 */
export function showsTeamEmpty({
  readerFiltered,
  narrowing,
  hiddenCount,
}: {
  readerFiltered: boolean;
  narrowing: boolean;
  hiddenCount: number;
}): boolean {
  return !readerFiltered && narrowing && hiddenCount > 0;
}

/** The URL after the reader ticks (`all` false: team spaces) or unticks the default: `space=all` or no `space`. */
export function withSpaceChoice(prev: URLSearchParams, all: boolean): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (all) next.set(SPACE_PARAM, "all");
  else next.delete(SPACE_PARAM);
  return next;
}

/** A list path widened to every space (`?space=all`) when `spanning`: a count across spaces opens the list it counted. */
export function withAllSpaces(path: string, spanning: boolean): string {
  return spanning ? `${path}?space=all` : path;
}
