// SPDX-License-Identifier: Apache-2.0

/**
 * The lists that span spaces and which spaces admit each: held with a role, where the permission
 * of the list's route holds (the org route lists nothing elsewhere). The « Vue d'ensemble » mode,
 * chosen in the switcher, opens them, and the dashboard drawn from them, on every space; outside
 * it each list is the current space's.
 */

import { chatActsIn } from "@appstrate/core/chat-contract";
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
} as const satisfies Record<string, PermissionRoute>;

export type SpaceList = keyof typeof LIST_ROUTE;
const SPACE_LISTS = Object.keys(LIST_ROUTE) as SpaceList[];

/** Whether a space's effective permission set admits something. */
type Admits = (permissions: readonly string[]) => boolean;

/** A space admits a route where one of its permissions opens it. */
const routeAdmits =
  (path: RoutePath): Admits =>
  (permissions) => {
    const access = ROUTE_ACCESS[path];
    return "anyOf" in access && access.anyOf.some((permission) => permissions.includes(permission));
  };

/** A space admits a list where its permissions open the list's route. */
export const listAdmits = (list: SpaceList): Admits => routeAdmits(LIST_ROUTE[list]);

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

/** What the caller may do in one space: its effective set there, the org-level grants included. */
export type SpaceGate = (permission: string) => boolean;

function gateIn(
  space: { permissions: readonly string[] },
  orgPermissions: readonly string[] = [],
): SpaceGate {
  return (permission) =>
    orgPermissions.includes(permission) || space.permissions.includes(permission);
}

/**
 * The spaces an action naming no space may act in: held with a role, and admitted by `admits`
 * judging the caller's gate there, as `usePermissions().can` judges the working space.
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

export function spaceChoice(eligible: readonly { id: string }[]): SpaceChoice {
  if (eligible.length === 0) return { kind: "none" };
  if (eligible.length === 1) return { kind: "one", spaceId: eligible[0]!.id };
  return { kind: "ask" };
}

/**
 * Whether `permission` holds in a row's space, where an action on that row acts: the working
 * space's gate when the row has no space or is the working space's, else the listed space's
 * (held with a role). A space the listing does not hold grants nothing.
 */
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

/** A route that serves the organization in the mode (`spansSpaces`: the chat). */
const spansSpaces = (path: RoutePath) =>
  "spansSpaces" in ROUTE_ACCESS[path] && ROUTE_ACCESS[path].spansSpaces === true;

/**
 * Whether rendering `path` keeps the mode: the lists and their rows, the routes serving the
 * organization (`spansSpaces`), any route of no space (the dashboard, `/`, is one), and an
 * address no route declares. Any other route leaves it, into the working space (the one an action
 * asking « Dans quel espace ? » entered).
 */
export function holdsOverview(path: RoutePath | undefined): boolean {
  return path === undefined || ofList(path) || spansSpaces(path) || !belongsToSpace(path);
}

/**
 * A route that spans spaces opens where some space admits it, whatever the working space grants:
 * a route serving the organization (`spansSpaces`: the chat) in every mode, a list's route (its
 * rows are every space's) in « Vue d'ensemble » only. `undefined` for any other route, which the
 * working space decides, as does every route before the space listing has answered.
 */
export function spanningRouteVerdict(
  path: RoutePath,
  spaces: readonly ListedSpace[] | undefined,
  overview: boolean,
): "granted" | "denied" | undefined {
  const list = overview ? listOf(path) : undefined;
  const admits: Admits | undefined = list
    ? listAdmits(list)
    : spansSpaces(path)
      ? routeAdmits(path)
      : undefined;
  if (!admits || !spaces) return undefined;
  return spaces.some(admittedIn(admits)) ? "granted" : "denied";
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

/**
 * Whether the composer may stage a file: an upload lands in the working space, and the turn
 * resolves it only where the chat acts.
 */
export function canAttachFrom(
  actingIds: readonly string[],
  workingSpaceId: string | null,
): boolean {
  return workingSpaceId !== null && actingIds.includes(workingSpaceId);
}
