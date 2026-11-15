// SPDX-License-Identifier: Apache-2.0

/**
 * The lists that span spaces (runs, schedules, files) and which spaces admit each: held with a
 * role (a listed space without one is a 400 on the org route) where the list's permission holds
 * (the org route grants nothing elsewhere). Each page widens to them through its « Espace » scope;
 * the « Vue d'ensemble » mode, chosen in the switcher, opens them on every space.
 */

import { canReadRuns, CORE_RESOURCE_LEVELS } from "@appstrate/core/permissions";
import { isUnder, ROUTE_ACCESS, SETTINGS_INDEX, type RoutePath } from "./route-access";
import { isSpaceEnterable } from "../hooks/use-current-space";

const SPACE_LISTS = ["runs", "schedules", "files"] as const;
export type SpaceList = (typeof SPACE_LISTS)[number];

/** Whether a space's effective permission set admits a list. */
export type AdmitsList = (permissions: readonly string[]) => boolean;

export const LIST_ADMITS: Record<SpaceList, AdmitsList> = {
  runs: (permissions) => canReadRuns((p) => permissions.includes(p)),
  schedules: (permissions) => permissions.includes("schedules:read"),
  files: (permissions) => permissions.includes("files:read"),
};

interface ListedSpace {
  id: string;
  access: string;
  permissions: readonly string[];
}

export function admittingSpaces<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  admits: AdmitsList,
): S[] {
  return (spaces ?? []).filter((space) => isSpaceEnterable(space) && admits(space.permissions));
}

/** The lists at least one space admits, in order. */
function overviewLists(spaces: readonly ListedSpace[] | undefined): SpaceList[] {
  return SPACE_LISTS.filter((list) => admittingSpaces(spaces, LIST_ADMITS[list]).length > 0);
}

/** The « Vue d'ensemble » is offered from two spaces admitting at least one of the lists. */
export function overviewOffered(spaces: readonly ListedSpace[] | undefined): boolean {
  const admits: AdmitsList = (permissions) =>
    SPACE_LISTS.some((list) => LIST_ADMITS[list](permissions));
  return admittingSpaces(spaces, admits).length >= 2;
}

/** The mode is on while the reader chose it AND it is offered; a lost space turns it off silently. */
export function overviewModeOn(chosen: boolean, spaces: readonly ListedSpace[] | undefined) {
  return chosen && overviewOffered(spaces);
}

const LIST_ROUTE: Record<SpaceList, RoutePath> = {
  runs: "/runs",
  schedules: "/schedules",
  files: "/files",
};
const listOf = (path: RoutePath) => SPACE_LISTS.find((list) => LIST_ROUTE[list] === path);

/** A row opened from a spanning list: its detail runs in the row's space (`?enterSpace=`), the mode stays. */
const LIST_DETAILS: readonly RoutePath[] = ["/agents/:scope/:name/runs/:runId", "/schedules/:id"];

/** Org-level routes that still ACT in the working space ("here"), which the mode does not name. */
const ACTS_IN_WORKING_SPACE: readonly RoutePath[] = ["/catalogue"];

const isOrgLevel = (permission: string) =>
  (CORE_RESOURCE_LEVELS as Record<string, string>)[permission.split(":")[0]!] === "org";

/**
 * A route judged by one space's permissions: the workspace settings, the routes acting "here",
 * and any route a permission of space level (or a module's, which the SPA cannot grade) opens.
 * The organization and account settings, and the `open` routes, belong to no space.
 */
function belongsToSpace(path: RoutePath): boolean {
  const here = [SETTINGS_INDEX.workspace, ...ACTS_IN_WORKING_SPACE];
  if (here.some((prefix) => isUnder(path, prefix))) return true;
  if (isUnder(path, SETTINGS_INDEX.organization) || isUnder(path, SETTINGS_INDEX.account)) {
    return false;
  }
  const access = ROUTE_ACCESS[path] as { anyOf?: readonly string[] };
  return access.anyOf?.some((permission) => !isOrgLevel(permission)) ?? false;
}

/**
 * Whether rendering `path` keeps the mode: the lists and their details, `/` (it lands on a list),
 * any route of no space, and an address no route declares. Any other route leaves it, into the
 * working space.
 */
export function holdsOverview(path: RoutePath | undefined): boolean {
  return (
    path === undefined ||
    path === "/" ||
    listOf(path) !== undefined ||
    LIST_DETAILS.includes(path) ||
    !belongsToSpace(path)
  );
}

/** Whether the shell links to `path` in the mode: a route that holds it, the home aside. */
export function shownInOverview(path: RoutePath): boolean {
  return path !== "/" && holdsOverview(path);
}

/** The mode's home: its first list a space admits; `/` without one. */
export function overviewLanding(spaces: readonly ListedSpace[] | undefined): RoutePath {
  const [first] = overviewLists(spaces);
  return first ? LIST_ROUTE[first] : "/";
}

/** Where choosing the mode on `path` goes: nowhere when the page holds it, else its home. */
export function overviewEntry(
  spaces: readonly ListedSpace[] | undefined,
  path: RoutePath | undefined,
): RoutePath | null {
  return path === undefined || shownInOverview(path) ? null : overviewLanding(spaces);
}

/** In the mode, a list's route opens where a space admits the list, whatever the working space grants. */
export function overviewListVerdict(
  path: RoutePath,
  spaces: readonly ListedSpace[] | undefined,
): "granted" | "denied" | undefined {
  const list = listOf(path);
  if (!list) return undefined;
  return admittingSpaces(spaces, LIST_ADMITS[list]).length > 0 ? "granted" : "denied";
}
