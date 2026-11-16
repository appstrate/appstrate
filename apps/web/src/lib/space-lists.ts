// SPDX-License-Identifier: Apache-2.0

/**
 * The lists that span spaces and which spaces admit each: held with a role, where the permission
 * of the list's route holds (the org route lists nothing elsewhere). The « Vue d'ensemble » mode,
 * chosen in the switcher, opens them, and the dashboard drawn from them, on every space; outside
 * it each list is the current space's.
 */

import { CORE_RESOURCE_LEVELS } from "@appstrate/core/permissions";
import { isUnder, ROUTE_ACCESS, SETTINGS_INDEX, type RoutePath } from "./route-access";
import { isSpaceEnterable } from "../hooks/use-current-space";

/** A route its permissions open, which a space's permission set can therefore admit. */
type PermissionRoute = {
  [P in RoutePath]: (typeof ROUTE_ACCESS)[P] extends { anyOf: readonly string[] } ? P : never;
}[RoutePath];

const LIST_ROUTE = {
  runs: "/runs",
  schedules: "/schedules",
  files: "/files",
  agents: "/agents",
  skills: "/skills",
  integrations: "/integrations",
  "mcp-servers": "/mcp-servers",
} as const satisfies Record<string, PermissionRoute>;

export type SpaceList = keyof typeof LIST_ROUTE;
const SPACE_LISTS = Object.keys(LIST_ROUTE) as SpaceList[];

/** Whether a space's effective permission set admits something. */
type Admits = (permissions: readonly string[]) => boolean;

/** A space admits a list where its permissions open the list's route. */
export const listAdmits =
  (list: SpaceList): Admits =>
  (permissions) =>
    ROUTE_ACCESS[LIST_ROUTE[list]].anyOf.some((permission) => permissions.includes(permission));

interface ListedSpace {
  id: string;
  access: string;
  permissions: readonly string[];
}

/** A space admits what `admits` asks when it is held with a role and its permissions answer. */
const admittedIn =
  (admits: Admits) =>
  (space: ListedSpace): boolean =>
    isSpaceEnterable(space) && admits(space.permissions);

export function admittingSpaces<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  admits: Admits,
): S[] {
  return (spaces ?? []).filter(admittedIn(admits));
}

/** Whether some space grants `permission`: in the mode, what opens a section drawn across spaces. */
export function grantedInSomeSpace(
  spaces: readonly ListedSpace[] | undefined,
  permission: string,
): boolean {
  return (spaces ?? []).some(admittedIn((permissions) => permissions.includes(permission)));
}

/** The « Vue d'ensemble » is offered from two spaces admitting at least one of the lists. */
export function overviewOffered(spaces: readonly ListedSpace[] | undefined): boolean {
  const admits: Admits = (permissions) => SPACE_LISTS.some((list) => listAdmits(list)(permissions));
  return admittingSpaces(spaces, admits).length >= 2;
}

/** The listing proves the mode no longer offered (a space lost): the choice is withdrawn. */
export function overviewLapsed(spaces: readonly ListedSpace[] | undefined): boolean {
  return spaces !== undefined && !overviewOffered(spaces);
}

const listOf = (path: RoutePath) => SPACE_LISTS.find((list) => LIST_ROUTE[list] === path);

/**
 * A list's route, or one row of it: the list's route followed by a parameter (`/schedules/:id`,
 * `/agents/:scope/:name`, its versions and its runs). A row opened from a spanning list runs in
 * the row's space (`?enterSpace=`), the mode staying on. `/integrations/new/mcp` creates: no row.
 */
const ofList = (path: RoutePath) =>
  SPACE_LISTS.some((list) => path === LIST_ROUTE[list] || path.startsWith(`${LIST_ROUTE[list]}/:`));

/** Org-level routes that still ACT in the working space ("here"), which the mode does not name. */
const ACTS_IN_WORKING_SPACE: readonly RoutePath[] = ["/catalogue"];

const isOrgLevel = (permission: string) =>
  (CORE_RESOURCE_LEVELS as Record<string, string>)[permission.split(":")[0]!] === "org";

/**
 * A route judged by one space's permissions: the workspace settings, the routes acting "here",
 * and any route a permission of space level (or a module's, which the SPA cannot grade) opens.
 * The organization and account settings, and the `open` routes (`/` among them), belong to no
 * space.
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
 * Whether rendering `path` keeps the mode, and so whether the shell links to it there: the lists
 * and their rows, any route of no space (the dashboard, `/`, is one), and an address no route
 * declares. Any other route leaves it, into the working space.
 */
export function holdsOverview(path: RoutePath | undefined): boolean {
  return path === undefined || ofList(path) || !belongsToSpace(path);
}

/** In the mode, a list's route opens where a space admits the list, whatever the working space grants. */
export function overviewListVerdict(
  path: RoutePath,
  spaces: readonly ListedSpace[] | undefined,
): "granted" | "denied" | undefined {
  const list = listOf(path);
  if (!list) return undefined;
  return (spaces ?? []).some(admittedIn(listAdmits(list))) ? "granted" : "denied";
}
