// SPDX-License-Identifier: Apache-2.0

/**
 * The space filter of the studio lists in « Tous les espaces »: team spaces by default, every
 * space or a pick of spaces one click away. Pure, so the URL rule and the row rule are tested without a router.
 */

/** The kinds of space the run list narrows to (`space_kind`). */
export type SpaceKind = "team" | "personal";

/** The `space` URL parameter of the studio lists. */
export const SPACE_PARAM = "space";

interface FilterableSpace {
  id: string;
  personal: boolean;
}

/** The value of the « Espaces d'équipe » preset in the filter: one tick that stands for every team space. */
export const TEAM_PRESET = "team";

/** What the reader sees: the team preset, every space, or a pick of spaces. */
type SpaceFilterMode = "team" | "all" | "custom";

interface SpaceFilterState {
  /** Whether the reader is offered the choice: at least two spaces admit the list. */
  offered: boolean;
  /** Whether the team preset exists: spaces of both kinds admit the list. It is then the default. */
  preset: boolean;
  mode: SpaceFilterMode;
  /** What narrows the client-side lists: the team spaces, the picked ones, `undefined` for every space. */
  spaceIds: string[] | undefined;
  /** What narrows the run list, which pages server side: the team kind or the picked ids, never both. */
  runs: { spaceKind?: SpaceKind; spaceIds?: string[] };
}

/**
 * `raw` is the `space` URL parameter, user input: absent is the default (the team preset when it
 * exists, else every space), `all` is every space, a comma-separated list is those spaces. Ids of
 * spaces that do not admit the list are dropped, and a list left empty reads as absent.
 */
export function resolveSpaceFilter(
  raw: string | null,
  spaces: readonly FilterableSpace[],
): SpaceFilterState {
  const offered = spaces.length >= 2;
  const team = spaces.filter((space) => !space.personal).map((space) => space.id);
  const preset = team.length > 0 && spaces.some((space) => space.personal);
  const admitted = new Set(spaces.map((space) => space.id));
  const picked =
    raw && raw !== "all" ? [...new Set(raw.split(","))].filter((id) => admitted.has(id)) : [];

  let mode: SpaceFilterMode = "all";
  if (offered && raw !== "all") mode = picked.length > 0 ? "custom" : preset ? "team" : "all";
  return {
    offered,
    preset,
    mode,
    spaceIds: mode === "team" ? team : mode === "custom" ? picked : undefined,
    runs: mode === "team" ? { spaceKind: "team" } : mode === "custom" ? { spaceIds: picked } : {},
  };
}

/**
 * The `space` parameter after the reader changed the ticks (`ticked`: the values the dropdown
 * now holds). The preset, ticked, wins over any space (it is offered alone while it is ticked);
 * else the ticked spaces are the pick, and none left is every space. `null` removes the
 * parameter: the default is the preset where it exists, every space where it does not.
 */
export function nextSpaceParam(ticked: readonly string[], preset: boolean): string | null {
  if (ticked.includes(TEAM_PRESET)) return null;
  if (ticked.length > 0) return ticked.join(",");
  return preset ? "all" : null;
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
 * reader filtered nothing, the team preset narrows (`narrowing`: team mode; a pick is the reader's filter), and the narrowing hides something. Otherwise the
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

/** The URL with the `space` parameter set to `value` (see {@link nextSpaceParam}), or removed when `null`. */
export function withSpaceChoice(prev: URLSearchParams, value: string | null): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (value === null) next.delete(SPACE_PARAM);
  else next.set(SPACE_PARAM, value);
  return next;
}

/** A list path widened to every space (`?space=all`) when `spanning`: a count across spaces opens the list it counted. */
export function withAllSpaces(path: string, spanning: boolean): string {
  return spanning ? `${path}?space=all` : path;
}
