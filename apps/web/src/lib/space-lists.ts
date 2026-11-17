// SPDX-License-Identifier: Apache-2.0

/**
 * The lists that span spaces in « Tous les espaces » and which spaces admit each: held with a role,
 * where the permission of the list's route holds.
 */

import { chatActsIn } from "@appstrate/core/chat-contract";
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

/** A route's declaration, read uniformly: the permissions that open it, if any. */
const accessOf = (path: RoutePath) =>
  ROUTE_ACCESS[path] as { anyOf?: readonly string[]; spansSpaces?: boolean };

/** A space admits a route where its gate opens it. */
const routeAdmits =
  (path: RoutePath) =>
  (can: SpaceGate): boolean =>
    accessOf(path).anyOf?.some(can) ?? false;

/** A space admits a list where its gate opens the list's route. */
export const listAdmits = (list: SpaceList) => routeAdmits(LIST_ROUTE[list]);

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
 * The spaces held with a role that `admits`, each judged as `usePermissions().can` judges the
 * working space. A list's permissions are of space level, so its verdicts need no `orgPermissions`.
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

/** Whether `permission` holds in a row's space: the working space's gate, or the row's own. */
export function grantsInRowSpace(
  rowSpaceId: string | undefined,
  workingSpaceId: string | null,
  can: SpaceGate,
  spaces: readonly ListedSpace[] | undefined,
  orgPermissions: readonly string[] | undefined,
  permission: string,
): boolean {
  if (!rowSpaceId || rowSpaceId === workingSpaceId) return can(permission);
  const space = spaces?.find((s) => s.id === rowSpaceId);
  return !!space && isSpaceEnterable(space) && gateIn(space, orgPermissions)(permission);
}

/**
 * Whether `permission` holds in `spaceId` among the spaces held with a role, or in any of them for
 * a row of no one space (an org-wide row an account page lists): judged by the row, never by the
 * working space.
 */
export function grantedForRow(
  spaces: readonly ListedSpace[] | undefined,
  orgPermissions: readonly string[] | undefined,
  spaceId: string | null,
  permission: string,
): boolean {
  return (
    spacesWhere(
      spaces,
      orgPermissions,
      (can, space) => (!spaceId || space.id === spaceId) && can(permission),
    ).length > 0
  );
}

/** An action naming no space: none eligible, one taken without asking, or the reader chooses. */
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

/** The « Tous les espaces » is offered from two spaces admitting at least one of the lists. */
export function overviewOffered(spaces: readonly ListedSpace[] | undefined): boolean {
  const admits = (can: SpaceGate) => SPACE_LISTS.some((list) => listAdmits(list)(can));
  return spacesWhere(spaces, undefined, admits).length >= 2;
}

const listOf = (path: RoutePath) => SPACE_LISTS.find((list) => LIST_ROUTE[list] === path);

/**
 * One row of a list: the list's route followed by a parameter (`/schedules/:id`,
 * `/agents/:scope/:name`, …). `/integrations/new/mcp` creates: no row.
 */
export function isListRow(path: RoutePath | undefined): boolean {
  return path !== undefined && SPACE_LISTS.some((list) => path.startsWith(`${LIST_ROUTE[list]}/:`));
}

const ofList = (path: RoutePath) => listOf(path) !== undefined || isListRow(path);

const isOrgLevel = (permission: string) =>
  (CORE_RESOURCE_LEVELS as Record<string, string>)[permission.split(":")[0]!] === "org";

/**
 * A route judged by one space's permissions: any route a space-level (or module) permission opens.
 * Organization and account settings, the catalogue and the `open` routes belong to no space. The
 * settings are overlays, never the page under them, so none of them withdraws the mode.
 */
function belongsToSpace(path: RoutePath): boolean {
  if (isUnder(path, SETTINGS_INDEX.organization) || isUnder(path, SETTINGS_INDEX.account)) {
    return false;
  }
  return accessOf(path).anyOf?.some((permission) => !isOrgLevel(permission)) ?? false;
}

/** A route that serves the organization in the mode (`spansSpaces`: the chat). */
const spansSpaces = (path: RoutePath) => accessOf(path).spansSpaces === true;

/**
 * Whether rendering `path` keeps the mode: the lists and their rows, the routes serving the
 * organization (`spansSpaces`), any route of no space, and an undeclared address. Any other route
 * leaves it, into the working space.
 */
export function holdsOverview(path: RoutePath | undefined): boolean {
  return path === undefined || ofList(path) || spansSpaces(path) || !belongsToSpace(path);
}

/**
 * A route that spans spaces opens where some space admits it, whatever the working space grants:
 * a route serving the organization (`spansSpaces`: the chat) in every mode, a list's route and one
 * of its rows (each judged by its own permissions) in « Tous les espaces » only: a row may be any
 * reached space's, and its page reopens in that space. `undefined` for any other route, which the
 * working space decides, as does every route before the space listing has answered.
 */
export function spanningRouteVerdict(
  path: RoutePath,
  spaces: readonly ListedSpace[] | undefined,
  overview: boolean,
): "granted" | "denied" | undefined {
  const spanning = spansSpaces(path) || (overview && ofList(path));
  // An `open` route (a file) is granted by its own declaration.
  if (!spanning || !spaces || !accessOf(path).anyOf) return undefined;
  const admits = routeAdmits(path);
  return spacesWhere(spaces, undefined, admits).length > 0 ? "granted" : "denied";
}

/**
 * The spaces the chat acts in, as the backend's acting set judges them: held with
 * a role, the caller's gate granting the chat's acting permissions there.
 */
export function actingSpaces<S extends ListedSpace>(
  spaces: readonly S[] | undefined,
  orgPermissions: readonly string[] | undefined,
): S[] {
  return spacesWhere(spaces, orgPermissions, (_can, space) =>
    chatActsIn([...(orgPermissions ?? []), ...space.permissions]),
  );
}

/**
 * What the chat may do, as the module's `can` reads it: `permission` holds in some space where the
 * chat may act. The working space's grants do not decide: a conversation acts in the spaces the
 * caller names.
 */
export function grantedInSomeActingSpace(
  spaces: readonly ListedSpace[] | undefined,
  orgPermissions: readonly string[] | undefined,
  permission: string,
): boolean {
  return actingSpaces(spaces, orgPermissions).some((space) =>
    gateIn(space, orgPermissions)(permission),
  );
}
