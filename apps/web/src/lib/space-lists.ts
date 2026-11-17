// SPDX-License-Identifier: Apache-2.0

/**
 * The lists that span spaces and which spaces admit each: held with a role, where the permission
 * of the list's route holds (the org route lists nothing elsewhere). The « Vue d'ensemble » mode,
 * chosen in the switcher, opens them, and the dashboard drawn from them, on every space; outside
 * it each list is the current space's.
 */

import { CORE_RESOURCE_LEVELS } from "@appstrate/core/permissions";
import { isUnder, ROUTE_ACCESS, SETTINGS_INDEX, type RoutePath } from "./route-access";

/** Only `member` access enters: scoping to a listed `access: "none"` space 403s every request. */
export function isSpaceEnterable(space: { access: string }): boolean {
  return space.access === "member";
}

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
} as const satisfies Record<string, PermissionRoute>;

export type SpaceList = keyof typeof LIST_ROUTE;
const SPACE_LISTS = Object.keys(LIST_ROUTE) as SpaceList[];

/** What the caller may do in one space: its effective set there, the org-level grants included. */
export type SpaceGate = (permission: string) => boolean;

/** A space admits a list where its gate opens the list's route. */
export const listAdmits =
  (list: SpaceList) =>
  (can: SpaceGate): boolean =>
    ROUTE_ACCESS[LIST_ROUTE[list]].anyOf.some(can);

interface ListedSpace {
  id: string;
  access: string;
  permissions: readonly string[];
}

function gateIn(
  space: { permissions: readonly string[] },
  orgPermissions: readonly string[] = [],
): SpaceGate {
  return (permission) =>
    orgPermissions.includes(permission) || space.permissions.includes(permission);
}

/**
 * The spaces held with a role that `admits`, judging the caller's gate there as
 * `usePermissions().can` judges the working space: where a list spanning spaces finds its rows,
 * where an action naming no space may act. A list's permissions are of space level, so its
 * verdicts need no `orgPermissions`.
 */
export function spacesWhere<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  orgPermissions: readonly string[] | undefined,
  admits: (can: SpaceGate, space: S) => boolean,
): S[] {
  return (spaces ?? []).filter(
    (space) => isSpaceEnterable(space) && admits(gateIn(space, orgPermissions), space),
  );
}

/**
 * How an action naming no space finds one in « Vue d'ensemble »: not offered without an eligible
 * space, the only one taken without asking, the reader asked between several.
 */
type SpaceChoice = { kind: "none" } | { kind: "one"; spaceId: string } | { kind: "ask" };

/** `preferred`, when eligible, is taken without asking: a row's action in the working space. */
export function spaceChoice(
  eligible: readonly { id: string }[],
  preferred: string | null = null,
): SpaceChoice {
  if (eligible.length === 0) return { kind: "none" };
  if (preferred && eligible.some((space) => space.id === preferred)) {
    return { kind: "one", spaceId: preferred };
  }
  if (eligible.length === 1) return { kind: "one", spaceId: eligible[0]!.id };
  return { kind: "ask" };
}

/** The « Vue d'ensemble » is offered from two spaces admitting at least one of the lists. */
export function overviewOffered(spaces: readonly ListedSpace[] | undefined): boolean {
  const admits = (can: SpaceGate) => SPACE_LISTS.some((list) => listAdmits(list)(can));
  return spacesWhere(spaces, undefined, admits).length >= 2;
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
 * Whether rendering `path` keeps the mode: the lists and their rows, any route of no space (the
 * dashboard, `/`, is one), and an address no route declares. Any other route leaves it, into the
 * working space (the one an action asking « Dans quel espace ? » entered).
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
  return spacesWhere(spaces, undefined, listAdmits(list)).length > 0 ? "granted" : "denied";
}
