// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  packages,
  packageShares,
  spaceMembers,
  spacePackages,
  spaceRoles,
  spaces,
} from "@appstrate/db/schema";
import { assertDependencyOverrideKeysDeclared } from "./launch-schemas.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { getLocalServerRef } from "../services/integration-manifest-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  VERSION_SELECTOR_DRAFT,
  VERSION_SELECTOR_PUBLISHED,
} from "../services/agent-version-resolver.ts";
import { getLatestVersionId } from "../services/package-versions.ts";
import { isPackageActiveHere } from "../services/space-packages.ts";
import { activeHereSql } from "../services/package-activation.ts";
import { parsePackageIdentity, type Bundle } from "@appstrate/afps-runtime/bundle";
import { makePermissionGuard, reportPermissionDenial } from "@appstrate/core/permissions";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import { getOrgMember, getOrgSettings } from "../services/organizations.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { PackageHome } from "@appstrate/shared-types";
import type { OrgRole, SpaceRolePreset, SpaceVisibility } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import type { SpaceScope } from "./scope.ts";
import { callerPermissions, type Permission } from "./permissions.ts";
import { isUserPrincipal } from "./principal.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  effectiveInSpace,
  personaFor,
  personaMemberships,
} from "./view-as.ts";
import {
  customRoleOn,
  MEMBERSHIP_COLUMNS,
  memberFromJoin,
  membershipOn,
  resolveSpaceRole,
} from "./space-role.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "./package-helpers.ts";
import { ApiError, forbidden, notFound, invalidRequest } from "./errors.ts";
import { placementRowJoin, placementShareJoin } from "../services/package-placement.ts";

const PACKAGE_RESOURCES = {
  agent: "agents",
  skill: "skills",
  integration: "integrations",
  "mcp-server": "mcp-servers",
} as const;

/**
 * Permissions BEYOND `<resource>:read` that also let a caller SEE a package of
 * this type (RBAC spec §3.4) — a table, because it is a fact of the permission
 * catalogue and not a branch of behaviour.
 *
 * `agents:run` is the one entry: it opens the list, the detail and the resolved
 * model the launch form reads, in a summary projection. So a `runner` reaches
 * an agent, and every predicate that asks "may this caller know this package
 * exists" — {@link requireAgentRead} as a route guard,
 * {@link assertPackageIsReachable} as the 403-vs-404 decision — reads this same
 * table. A type absent from it has exactly one read permission.
 */
const PACKAGE_EXTRA_READ_PERMISSIONS: Partial<Record<PackageType, readonly Permission[]>> = {
  agent: ["agents:run"],
};

export function packagePermission(
  type: PackageType,
  action: "read" | "write" | "delete" | "share",
): Permission {
  return `${PACKAGE_RESOURCES[type]}:${action}`;
}

export const PACKAGE_WRITE_PERMISSIONS = Object.values(PACKAGE_RESOURCES).map(
  (resource) => `${resource}:write` as Permission,
);

/**
 * Which permissions let a caller SEE a package of this type — the one statement
 * of that rule (RBAC spec §3.4), read off
 * {@link PACKAGE_EXTRA_READ_PERMISSIONS} so the disjunction is data.
 */
function packageReadPermissions(type: PackageType): readonly Permission[] {
  return [packagePermission(type, "read"), ...(PACKAGE_EXTRA_READ_PERMISSIONS[type] ?? [])];
}

/**
 * The read guard of the three agent routes `agents:run` also opens: the list,
 * the detail, and the resolved model the launch form reads (RBAC spec §3.4).
 * Every other agent surface keeps its `agents:read` / `agents:write` guard.
 */
export const requireAgentRead = requireAnyPermission(packageReadPermissions("agent"));

/**
 * `agents:run` without `agents:read` — the caller sees what the launch form
 * needs and nothing an author would call the agent's content.
 *
 * The three routes above answer this ONE question to shape their projection;
 * none of them re-derives the condition.
 */
export function agentReadIsSummary(c: Context<AppEnv>): boolean {
  return !callerPermissions(c).has("agents:read");
}

/**
 * The permission one ACT on a space placement asks for, per package type.
 *
 * The act is spelled activate / configure / deactivate everywhere the platform
 * talks about it; the permission STRINGS keep the spelling they have in
 * `space_roles` rows and in every API key's scope list
 * (`integrations:install` / `integrations:uninstall`). Those are data, and
 * renaming a grant is a migration of rows, not of code — so the mapping is the
 * one place where the two vocabularies meet.
 */
export function spacePackagePermission(
  type: PackageType,
  op: "activate" | "configure" | "deactivate",
): Permission {
  if (type === "agent") return "agents:configure";
  if (type === "integration")
    return op === "deactivate" ? "integrations:uninstall" : "integrations:install";
  return packagePermission(type, "write");
}

/**
 * Existing catalog imports must hold the target's activation grant unless the
 * import CHANGES nothing — i.e. unless the package is already ACTIVE here
 * ({@link activeHereSql}, `services/package-activation.ts`).
 *
 * ACTIVE and not merely PLACED, because the act this gates IS an activation:
 * `importBundle` ends by calling `activatePackage` on the root. Waiving the
 * grant on a placed row that says `false` would let an import switch a package
 * the space had deliberately switched OFF back on, and the sticky opt-out is a
 * decision the import path is no more entitled to overrule than the HTTP door
 * is. Reachable wherever a custom space role grants `<type>:write` without the
 * activation string — both presets that write also activate.
 *
 * A bare `space_packages` row is not enough either, for the reason the
 * activation rule conjoins placement: an ORPHAN row reads as active nowhere,
 * so leaning on it would let the leftover of a revoked offer stand in for the
 * offer itself.
 *
 * The deployment's own default is an activation nobody performed and waives the
 * grant on its own: a system package, and an integration `SYSTEM_INTEGRATIONS`
 * names, are already on with no row at all.
 */
export async function assertExistingPackageActivationAccess(
  c: Context<AppEnv>,
  packageId: string,
  type: PackageType,
) {
  const target = c.get("space")?.id ?? c.get("spaceId");
  const [active] = await db
    .select({ id: packages.id })
    .from(packages)
    // Both of `activeHereSql`'s LEFT JOINs, and they are the question rather
    // than decoration: without the first the row half is always NULL and every
    // package falls back to the deployment default, without the second every
    // offered package reads as unplaced and its row stops counting.
    .leftJoin(spacePackages, placementRowJoin(packages.id, target))
    .leftJoin(packageShares, placementShareJoin(packages.id, target))
    .where(
      and(
        eq(packages.id, packageId),
        orgOrSystemFilter(c.get("orgId")),
        notEphemeralFilter(),
        activeHereSql(target),
      ),
    )
    .limit(1);
  if (!active)
    await makePermissionGuard(spacePackagePermission(type, "activate"))(c, async () => {});
}

/**
 * One space of the caller's reach, with their effective permissions in it.
 *
 * Written out rather than inferred from the resolver: the memo that returns it
 * lives on the Hono context, so `AppEnv` names this type and inferring it back
 * off the resolver would close the loop through the environment.
 */
export interface PackageAccessSpace {
  id: string;
  name: string;
  isDefault: boolean;
  visibility: SpaceVisibility;
  defaultRole: SpaceRolePreset;
  ownerUserId: string | null;
  permissions: ReadonlySet<string>;
}

/**
 * A package read that crosses into ANOTHER organization, with the standing the
 * caller holds THERE. Both halves travel together because neither is derivable
 * from the request: `c.get("orgRole")` is the role in the org the request is
 * scoped to, and a foreign org has no persona to read one off.
 */
export interface ForeignOrgStanding {
  orgId: string;
  orgRole: OrgRole;
}

/**
 * Resolve once for catalog listings and cross-space package operations. The org
 * role and the memberships are the CALLER's standing, which a preview replaces
 * — otherwise the catalog answers with the previewing admin's reach.
 *
 * NO argument means the org the request is scoped to. Another organization is
 * reachable only by naming the caller's role in it ({@link ForeignOrgStanding}),
 * and the type is what enforces that: `callerOrgRole` falls back to
 * `c.get("orgRole")` when the org has no persona, so a foreign org resolved
 * without a role would grant the caller their CURRENT org's standing over
 * somebody else's spaces — an owner here reading a private space there. That
 * failure is silent and it fails OPEN, which is why the role is not an optional
 * parameter with a default.
 */
export async function packageAccessSpaces(c: Context<AppEnv>, foreign?: ForeignOrgStanding) {
  const orgId = foreign?.orgId ?? c.get("orgId");
  const orgRole = foreign?.orgRole ?? callerOrgRole(c, orgId);
  // MEMOIZED per request. Every authority and reachability decision needs this
  // set, so a single route resolved it up to four times over; an optional
  // `resolvedSpaces` parameter threaded through the signatures instead would
  // cost a query when forgotten and a wrong answer when stale. The cache lives
  // on the Hono context, so it dies with the request and cannot outlive the
  // standing it describes.
  //
  // Keyed on the org AND the role, not the org alone: one request can ask about
  // two organizations (the cross-organization fork), and a key that dropped the
  // role would let whichever call ran first decide for the other.
  const cache =
    c.get("packageAccessSpacesCache") ?? new Map<string, Promise<PackageAccessSpace[]>>();
  if (!c.get("packageAccessSpacesCache")) c.set("packageAccessSpacesCache", cache);
  const key = `${orgId}:${orgRole}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = resolvePackageAccessSpaces(c, orgId, orgRole);
  cache.set(key, pending);
  return pending;
}

/** The read itself — {@link packageAccessSpaces} is the memo in front of it. */
async function resolvePackageAccessSpaces(
  c: Context<AppEnv>,
  orgId: string,
  orgRole: OrgRole,
): Promise<PackageAccessSpace[]> {
  const callerId = callerPersonalOwnerId(c, orgId);
  const tokenOnly = Boolean(c.get("endUser")) && !c.get("orgRole");
  const persona = personaFor(c, orgId);
  // Spaces and the caller's rows in one statement (RBAC spec §4.4); none under a
  // preview (the overlay replaces them) or for an end-user token (no org role).
  const joined = await db
    .select({
      space: {
        id: spaces.id,
        name: spaces.name,
        isDefault: spaces.isDefault,
        visibility: spaces.visibility,
        defaultRole: spaces.defaultRole,
        ownerUserId: spaces.ownerUserId,
      },
      ...MEMBERSHIP_COLUMNS,
    })
    .from(spaces)
    .leftJoin(spaceMembers, membershipOn(tokenOnly || persona ? null : c.get("user").id))
    .leftJoin(spaceRoles, customRoleOn)
    .where(
      and(
        eq(spaces.orgId, orgId),
        c.get("authMethod") === "api_key" || c.get("endUser")
          ? eq(spaces.id, c.get("spaceId"))
          : undefined,
        // Someone else's personal space is never even LOADED. `resolveSpaceRole`
        // would drop it anyway, but with one personal space per member this
        // query would otherwise grow with the organization's headcount on
        // every catalog read (RBAC spec §3.6).
        callerId === null
          ? isNull(spaces.ownerUserId)
          : or(isNull(spaces.ownerUserId), eq(spaces.ownerUserId, callerId)),
      ),
    );
  const overlay = personaMemberships(persona);
  return joined.flatMap((row) => {
    const { space } = row;
    if (tokenOnly) {
      return space.id === c.get("spaceId") ? [{ ...space, permissions: callerPermissions(c) }] : [];
    }
    const member = overlay ? (overlay.get(space.id) ?? null) : memberFromJoin(row);
    const ref = resolveSpaceRole(orgRole, space, member, callerId);
    if (!ref) return [];
    return [
      {
        ...space,
        permissions: effectiveInSpace(c, ref),
      },
    ];
  });
}

/**
 * Does a package's PLACEMENT grant read from these spaces? — the IN-MEMORY form
 * of the rule `placementReadFilter` states in SQL
 * (`services/package-placement.ts`, which carries the reasoning; RBAC spec
 * §6.9, §6.10). Homed there, or shared there. A `space_packages` row is not a
 * third placement.
 *
 * Its readers differ only in the set they compare against — the org-wide
 * catalog check below, the current-space gate ({@link isPackageReadableInSpace}),
 * the library listing. Holding `<type>:read` in one of those spaces is the
 * other half of the rule and stays with each reader.
 *
 * READ only. RUNNING asks this AND one more ({@link agentExecutionBlock}:
 * placed here *and* ACTIVE here), which is why a share is not an activation —
 * an agent runs with the recipient's credentials, so the recipient switches it
 * on themselves.
 */
export function placementGrantsRead(
  pkg: { homeSpaceId: string | null },
  sharedIn: Iterable<string>,
  readable: ReadonlySet<string>,
): boolean {
  if (pkg.homeSpaceId !== null && readable.has(pkg.homeSpaceId)) return true;
  for (const spaceId of sharedIn) if (readable.has(spaceId)) return true;
  return false;
}

/**
 * "Is this package readable from THIS space?" — VISIBILITY, not authorization:
 * the caller's `<type>:read` is a separate guard (the route's `readGuard`, or
 * `requirePackageReadPermission` where the type comes from the row). System
 * packages are readable from every space, and like `isPackageActiveHere` this does
 * not filter `orgId`: its callers add the org boundary on the row they read next.
 */
export async function isPackageReadableInSpace(
  spaceId: string,
  packageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      sharedHere: packageShares.packageId,
    })
    .from(packages)
    .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
    .where(and(eq(packages.id, packageId), notEphemeralFilter()))
    .limit(1);
  if (!row) return false;
  if (row.source === "system") return true;
  const here = new Set([spaceId]);
  return placementGrantsRead(row, row.sharedHere ? here : [], here);
}

/**
 * Why a package may NOT execute in a space — `null` when it may.
 *
 * `"not_placed"` beats `"not_active"`: a space that holds no placement is told
 * nothing about a switch it was never entitled to throw.
 */
export type AgentExecutionBlock = "not_placed" | "not_active";

/**
 * THE execution predicate: may this package RUN in this space?
 *
 * Two halves, and both must answer yes — they are different questions and
 * neither implies the other:
 *
 *   - PLACED here: homed here, offered here, or shipped with the deployment
 *     ({@link isPackageReadableInSpace} — the same rule the reads use);
 *   - ACTIVE here: the placement row's `enabled`, or the deployment's default
 *     where there is no row (`isPackageActiveHere` / `activeHereSql`).
 *
 * Stated ONCE because three callers ask it and drift between them is invisible:
 * the HTTP door (`requireActiveAgent`, `middleware/guards.ts`, mounted by
 * `POST …/run`, `POST …/schedules` and `GET …/bundle`), the remote-run resolver
 * (`services/registry-run-resolver.ts`, behind `POST /api/runs/remote`) and the
 * scheduler tick, which fires on its own with no request to refuse. The
 * activation half ALONE would let an ORPHAN placement execute from a cron in a
 * space every HTTP door refuses to serve it to.
 *
 * A VERDICT rather than a throw: each caller renders the refusal on its own
 * channel — a 404 with a code at the HTTP door, the resolver's own 404 pair, a
 * visible failed run with the schedule left ARMED at the tick.
 *
 * Both halves are read in parallel: independent rows, and the tick pays for
 * this on every fire. No `orgId` predicate of its own — `isPackageActiveHere`
 * carries the org boundary, and every caller has already loaded the package
 * under it.
 */
export async function agentExecutionBlock(
  scope: SpaceScope,
  packageId: string,
): Promise<AgentExecutionBlock | null> {
  const [placed, active] = await Promise.all([
    isPackageReadableInSpace(scope.spaceId, packageId),
    isPackageActiveHere(scope, packageId),
  ]);
  if (!placed) return "not_placed";
  if (!active) return "not_active";
  return null;
}

/**
 * Catalog reachability permits copying between accessible spaces, never guessing
 * a private id.
 *
 * `source` names ANOTHER organization, and carries the caller's role in it: a
 * fork may cross organizations, and the reachability it asks about is
 * reachability THERE. The role travels with the id rather than being defaulted,
 * for the reason {@link packageAccessSpaces} gives — resolving a foreign org
 * under `c.get("orgRole")` hands the caller their current standing over
 * somebody else's spaces, silently and open.
 */
export async function assertCatalogPackageAccess(
  c: Context<AppEnv>,
  packageId: string,
  source?: ForeignOrgStanding,
) {
  const sourceOrgId = source?.orgId ?? c.get("orgId");
  const [pkg, accessible, sharedIn] = await Promise.all([
    loadPackageRow(packageId, sourceOrgId),
    packageAccessSpaces(c, source),
    loadPackageShares(packageId, sourceOrgId),
  ]);
  assertPackageIsReachable(packageId, pkg, sharedIn, accessible);
  return pkg;
}

type PackageAccessRow = Awaited<ReturnType<typeof loadPackageRow>>;

/**
 * The five columns every access decision reads, as a QUESTION — `null` when the
 * org cannot see the id at all.
 *
 * One catalogue query, defined once: the throwing reader below and the boolean
 * {@link holdsPackageWriteAuthority} decide differently about an invisible id
 * (404 vs `false`) but must never disagree about which ids are visible, and two
 * hand-written copies of `orgOrSystemFilter` + `notEphemeralFilter` is exactly
 * how that drifts.
 */
async function findPackageRow(packageId: string, orgId: string) {
  const [pkg] = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      orgId: packages.orgId,
      homeSpaceId: packages.homeSpaceId,
    })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
    .limit(1);
  return pkg ?? null;
}

/** The same read, for the callers that answer a missing id with 404. */
async function loadPackageRow(packageId: string, orgId: string) {
  const pkg = await findPackageRow(packageId, orgId);
  if (!pkg) throw notFound(`Package '${packageId}' not found`);
  return pkg;
}

/**
 * Every space of `orgId` the package is SHARED into — the one placement
 * {@link placementGrantsRead} needs beyond the home, which is a column on the
 * row itself.
 *
 * Split out from the row read because the write path never needs it: authority
 * is the home alone, so the shares are loaded only when a refusal has to decide
 * between 403 and 404.
 */
async function loadPackageShares(packageId: string, orgId: string): Promise<string[]> {
  const shared = await db
    .select({ spaceId: packageShares.spaceId })
    .from(packageShares)
    .innerJoin(spaces, eq(spaces.id, packageShares.spaceId))
    .where(and(eq(packageShares.packageId, packageId), eq(spaces.orgId, orgId)));
  return shared.map((row) => row.spaceId);
}

/**
 * 404 unless the caller may know this id exists — {@link placementGrantsRead}
 * + `<type>:read`.
 *
 * PLACEMENT is the whole rule, with no exception beside it. A package of the
 * organization is always homed in one of its spaces
 * (`packages_org_package_has_home`), so reaching it means reaching that space
 * or one the package was offered to; an owner or admin gets there because they
 * reach every team space, not through an authority of their own. That is what
 * keeps a draft sitting switched off in a member's PERSONAL space out of an
 * admin's reach, which is the one thing §3.6 refuses.
 */
function assertPackageIsReachable(
  packageId: string,
  pkg: PackageAccessRow,
  sharedIn: readonly string[],
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): void {
  if (packageReadSpaces(pkg, sharedIn, accessible).length === 0) {
    throw notFound(`Package '${packageId}' not found`);
  }
}

/**
 * Every space of the caller's reach this package is READ from — the type's
 * read permission held there ({@link packageReadPermissions}) and the placement
 * granting it there ({@link placementGrantsRead}); every such space for a
 * system package, which the platform places everywhere.
 *
 * The reachability rule is "this set is not empty", so the refusal above and
 * the listing {@link resolvePackageHome} publishes cannot disagree about a
 * single space.
 */
function packageReadSpaces(
  pkg: PackageAccessRow,
  sharedIn: readonly string[],
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): PackageAccessSpace[] {
  const opens = packageReadPermissions(pkg.type);
  return accessible.filter(
    (space) =>
      opens.some((permission) => space.permissions.has(permission)) &&
      (isSystemPackageRow(pkg) || placementGrantsRead(pkg, sharedIn, new Set([space.id]))),
  );
}

/**
 * A package's home and its reach, resolved across EVERY space the caller
 * reaches rather than the one in `X-Space-Id` — `GET …/home`.
 *
 * That is the question the per-type detail cannot answer: it reads from the
 * current space alone, so a package homed in the caller's personal space and
 * offered nowhere is a 404 from every team space. A client holding only an id
 * — the CLI, pointed at a working folder — asks here which space to address.
 *
 * 404 exactly when {@link assertCatalogPackageAccess} would refuse, from the
 * same three reads. `home_*` is {@link homeWireForCaller}, so a home the caller
 * does not reach stays `null` even when a share makes the package readable;
 * `read_space_ids` puts the home first when it is one of them, then sorts by
 * id so the answer does not depend on row order.
 */
export async function resolvePackageHome(
  c: Context<AppEnv>,
  packageId: string,
): Promise<PackageHome> {
  const orgId = c.get("orgId");
  const [pkg, accessible, sharedIn] = await Promise.all([
    loadPackageRow(packageId, orgId),
    packageAccessSpaces(c),
    loadPackageShares(packageId, orgId),
  ]);
  assertPackageIsReachable(packageId, pkg, sharedIn, accessible);
  const rank = (id: string) => (id === pkg.homeSpaceId ? 0 : 1);
  const readSpaceIds = packageReadSpaces(pkg, sharedIn, accessible)
    .map((space) => space.id)
    .sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    id: pkg.id,
    type: pkg.type,
    ...homeWireForCaller(pkg, accessible),
    read_space_ids: readSpaceIds,
  };
}

/**
 * Write authority is the package's HOME (`packages.home_space_id`) and nothing
 * else — not the space the caller happens to be in, not the set of spaces it is
 * placed in: those consume the package and have no say over its draft,
 * versions or identity. There is no second authority beside it: an
 * organization's package always has a home (`packages_org_package_has_home`),
 * and an owner or admin governs one because they reach every team space, the
 * organization's DEFAULT space included.
 *
 * There is deliberately no permission check against the CURRENT space. The home
 * lookup goes through `packageAccessSpaces` → `effectiveInSpace`, so it already
 * carries the view-as persona and the credential ceiling, and it already pins an
 * API key to its own space. A second check would turn the rule into "home AND
 * wherever I am browsing from", making a builder's own package unwritable from
 * a space where they only read.
 *
 * Returns the loaded row so a caller that has to act on it does not read it again.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.9
 */
export async function assertPackageMutationAccess(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete",
): Promise<PackageAccessRow> {
  return assertHomeAuthority(c, packageId, action);
}

/**
 * The home rule asked as a QUESTION rather than as a refusal — the ONE
 * predicate behind every "may this caller write / share this package" decision
 * that must not throw. `verb` picks which permission the HOME space has to
 * carry; nothing else about the two answers differs, which is why they are one
 * function.
 *
 * `write` governs the DRAFT — the author's working copy, which executes for
 * whoever can WRITE the package and for nobody else. Four callers each answer
 * something of their own (a `403 draft_not_writable`, a published fallback, a
 * projection) and none wants the assert's 404/403 split, so the rule is stated
 * as a boolean once here rather than re-derived four times.
 *
 * `share` is {@link assertPackageShareAccess}'s, for the one caller that has to
 * CHOOSE rather than refuse: a bundle import whose root lives in another space
 * activates it with the offer when the caller may make one, and reports
 * `root_active: false` when they may not.
 *
 * `false`, never a throw, for every refusal either assert would spell out.
 */
async function holdsPackageAuthority(
  c: Context<AppEnv>,
  packageId: string,
  verb: "write" | "share",
): Promise<boolean> {
  const orgId = c.get("orgId");
  const pkg = await findPackageRow(packageId, orgId);
  if (!pkg) return false;
  if (isSystemPackageRow(pkg) || pkg.orgId !== orgId) return false;
  const accessible = await packageAccessSpaces(c);
  return holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, verb));
}

/**
 * The `write` half, module-local on purpose. Every caller outside this file
 * reaches it through one of the three wordings below —
 * {@link assertDraftSelectorAllowed},
 * {@link assertDependencyDraftOverridesAllowed},
 * {@link defaultDefinitionSelector} — so a route cannot invent a fourth way of
 * spelling the same refusal.
 */
async function holdsPackageWriteAuthority(c: Context<AppEnv>, packageId: string): Promise<boolean> {
  return holdsPackageAuthority(c, packageId, "write");
}

/** The `share` half, for the bundle import that chooses instead of refusing. */
export async function holdsPackageShareAuthority(
  c: Context<AppEnv>,
  packageId: string,
): Promise<boolean> {
  return holdsPackageAuthority(c, packageId, "share");
}

/**
 * Refuse a `version=draft` launch by a caller who cannot WRITE the package —
 * `403 draft_not_writable` (plan decision 4).
 *
 * A no-op for every other selector, the omitted one included: an omitted
 * selector is the published `latest` (#636), which anybody who may run the
 * agent may run. Only the DRAFT is restricted, and it is restricted to its
 * authors: a head deployment is the developer's, the rule Apps Script states.
 *
 * A thin throw around {@link holdsPackageWriteAuthority} rather than six copies
 * of the same `ApiError` across the run route, the two schedule routes, the
 * input-settings route and the readiness endpoint: they all refuse the same act
 * for the same reason, and a refusal worded five ways is five contracts.
 */
export async function assertDraftSelectorAllowed(
  c: Context<AppEnv>,
  packageId: string,
  selector: string | undefined | null,
): Promise<void> {
  if (selector?.trim() !== VERSION_SELECTOR_DRAFT) return;
  if (await holdsPackageWriteAuthority(c, packageId)) return;
  throw draftNotWritable(packageId);
}

/**
 * WHICH definition a READ of a package renders when the caller named none —
 * the agent detail page, its readiness badge and the input-settings editor,
 * which must all judge the same bytes or the badge contradicts the form.
 *
 * Reading is not executing (RBAC spec §6.10). An author reads their DRAFT;
 * everybody else reads the latest PUBLISHED version — unless nothing is
 * published, in which case the draft is the only definition there is and hiding
 * it would 404 a page the list just linked to. The refusal belongs to the
 * LAUNCH (`404 no_published_version`), and the wire carries `definition` so the
 * reader is told which of the two they got.
 *
 * An EXPLICIT `?version=draft` is a different act and keeps its own rule:
 * naming the working copy is an author's move, refused with
 * `403 draft_not_writable` ({@link assertDraftSelectorAllowed}).
 *
 * A system package ships its definition with the platform and has no
 * `package_versions` rows at all; it is published by construction, and every
 * selector resolves to the same bytes.
 */
export async function defaultDefinitionSelector(
  c: Context<AppEnv>,
  agent: { id: string; source: string },
): Promise<{
  selector: typeof VERSION_SELECTOR_DRAFT | typeof VERSION_SELECTOR_PUBLISHED;
  writable: boolean;
}> {
  if (agent.source === "system") return { selector: VERSION_SELECTOR_PUBLISHED, writable: false };
  const writable = await holdsPackageWriteAuthority(c, agent.id);
  if (writable) return { selector: VERSION_SELECTOR_DRAFT, writable };
  const published = await getLatestVersionId(agent.id);
  return { selector: published ? VERSION_SELECTOR_PUBLISHED : VERSION_SELECTOR_DRAFT, writable };
}

/**
 * The same refusal, applied to every DEPENDENCY a launch opts into its working
 * copy — `dependency_overrides: { "@acme/skill": "draft" }` on the run route,
 * the remote-run route and both schedule writes.
 *
 * `version=draft` and a dependency override spelled `draft` are ONE act, and
 * the authority that decides is the authority over THAT package — the
 * overridden skill, not the agent that declares it.
 *
 * FORM FIRST, which is why the effective manifest is a parameter: a key naming
 * no declared dependency is a MALFORMED request, not an unauthorized one, and
 * judging authority over it answers `403 draft_not_writable` for an act the
 * launch would never have performed. `assertDependencyOverrideKeysDeclared`
 * runs first, here, so no caller can order the two wrong.
 *
 * Non-`draft` values are version specs and stay a pure value concern: they can
 * only name something the author already published.
 */
export async function assertDependencyDraftOverridesAllowed(
  c: Context<AppEnv>,
  overrides: Readonly<Record<string, string>> | null | undefined,
  /** The manifest the launch will EXECUTE — a draft and a published version do not declare the same dependencies. */
  manifest: Record<string, unknown>,
): Promise<void> {
  assertDependencyOverrideKeysDeclared(manifest, overrides);
  if (!overrides) return;
  for (const [dependencyId, selector] of Object.entries(overrides)) {
    await assertDraftSelectorAllowed(c, dependencyId, selector);
  }
}

/**
 * The refusal itself, for the one caller that has already asked
 * {@link holdsPackageWriteAuthority} for its own reasons — the agent detail
 * page, which needs the verdict to pick its DEFAULT view as well as to police
 * an explicit `?version=draft`, and would otherwise read the package row twice
 * to answer the same question.
 */
export function draftNotWritable(packageId: string): ApiError {
  return new ApiError({
    status: 403,
    code: "draft_not_writable",
    title: "Draft Not Writable",
    detail:
      `Running the draft of '${packageId}' requires write authority on it — ` +
      `omit the version selector to run the latest published version instead.`,
  });
}

/**
 * Authority to change a package's AUDIENCE — `<type>:share` in its home space
 * (RBAC spec §6.10). The same rule, the same reader and the same 404/403 split
 * as a mutation: the home decides, and an unreachable id stays a 404.
 *
 * It is a THIRD verb rather than a reuse of `write`, because an organization
 * may want Notion's split — authors who edit but do not distribute — and it
 * expresses that by dropping `share` from a custom role. Every preset that
 * writes also shares (`admin`, `builder`, both derived from the catalog), so
 * nothing narrows for a preset-only organization.
 */
export async function assertPackageShareAccess(
  c: Context<AppEnv>,
  packageId: string,
): Promise<PackageAccessRow> {
  return assertHomeAuthority(c, packageId, "share");
}

/** The home rule itself, for each of the three verbs that ask it. */
async function assertHomeAuthority(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete" | "share",
): Promise<PackageAccessRow> {
  const orgId = c.get("orgId");
  const [pkg, accessible] = await Promise.all([
    loadPackageRow(packageId, orgId),
    packageAccessSpaces(c),
  ]);
  // The catalog read above is `orgOrSystemFilter`ed, so another org's package
  // never loads at all (404). A row whose org does not match is a SYSTEM one —
  // the `source` column says the same thing, and {@link isSystemPackageRow} is
  // where both spellings live, because `homeWireForCaller` has to answer the
  // same way with only one of the two columns to hand.
  if (isSystemPackageRow(pkg) || pkg.orgId !== orgId) {
    throw forbidden(
      action === "share"
        ? "Cannot share a system package — it is already readable in every space."
        : "Cannot modify a system package.",
    );
  }
  const permission = packagePermission(pkg.type, action);
  if (holdsHomeAuthority(pkg, accessible, permission)) return pkg;
  // Refused. Whether the caller may even KNOW this id exists is the read
  // question, answered by the one predicate that answers it — an unreachable
  // package stays a 404 rather than becoming an existence oracle. Only this
  // path pays for the placements.
  assertPackageIsReachable(packageId, pkg, await loadPackageShares(packageId, orgId), accessible);
  reportPermissionDenial(c, permission);
  const verb = action === "share" ? "Sharing" : "Modifying";
  throw forbidden(`${verb} '${packageId}' requires '${permission}' in its home space.`);
}

/**
 * The `home_*` fields EVERY package read emits — one contract, computed once,
 * for `AgentDetail`, `OrgPackageItem`, `OrgPackageItemDetail` and the library
 * listing.
 *
 * `home_space_id` is the home's id **only when the caller reaches that space**,
 * and `null` otherwise. The raw column cannot go on the wire: a package homed in
 * a member's PERSONAL space is legitimately readable by everyone it is placed
 * for, and emitting its home would hand each of them the id of a space §3.6
 * says does not exist for them. `null` means "not a space you can see".
 *
 * `home_writable` is `assertPackageMutationAccess`'s WHOLE rule for `write`, not
 * just its home half: a SYSTEM package is refused there before the home is
 * consulted, so it answers `false` here too, however much authority the caller
 * holds — otherwise the SPA renders a button that 403s on click.
 *
 * `home_deletable` is the same answer for the type's `delete`, and it is a field
 * of its own for the reason the field above exists at all: `<type>:delete` is an
 * INDEPENDENT permission string (`@appstrate/core/permissions`), enforced in its
 * own right by `requirePackageInOrg("delete")`. Every preset that writes also
 * deletes, so nothing narrows for a preset-only organization — but a custom
 * space role is an arbitrary bundle, and one holding `write` without `delete`
 * read as "may delete" for as long as the SPA gated its Supprimer item on
 * `home_writable`.
 *
 * `home_shareable` is the same answer for the type's `share` (RBAC spec §6.10),
 * a field of its own because a custom role may hold one verb without the other.
 */
export function homeWireForCaller(
  pkg: { type: PackageType; source: string; homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): {
  home_space_id: string | null;
  home_writable: boolean;
  home_deletable: boolean;
  home_shareable: boolean;
} {
  const reached =
    pkg.homeSpaceId !== null && accessible.some((space) => space.id === pkg.homeSpaceId);
  const system = isSystemPackageRow(pkg);
  const holds = (action: "write" | "delete" | "share") =>
    !system && holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, action));
  return {
    home_space_id: reached ? pkg.homeSpaceId : null,
    home_writable: holds("write"),
    home_deletable: holds("delete"),
    home_shareable: holds("share"),
  };
}

/**
 * {@link homeWireForCaller}'s `home_writable`, asked for MANY packages in one
 * catalogue read — the dependency list of an agent, the active-package hints
 * served to a model.
 *
 * Both surfaces offer the draft of a package OTHER than the one being read, and
 * the run route now refuses that draft to whoever cannot write it
 * ({@link assertDependencyDraftOverridesAllowed}). Offering the option without
 * the answer turns a silent 403 into a clickable one, and asking per entry
 * turns a list into N catalogue queries.
 *
 * Ids the org cannot see are simply absent from the map — a caller reads it as
 * `false`, which is the same verdict the assert would reach.
 */
export async function homeWritableForPackages(
  c: Context<AppEnv>,
  packageIds: readonly string[],
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<Map<string, boolean>> {
  const ids = [...new Set(packageIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      orgId: packages.orgId,
      homeSpaceId: packages.homeSpaceId,
    })
    .from(packages)
    .where(and(inArray(packages.id, ids), orgOrSystemFilter(c.get("orgId")), notEphemeralFilter()));
  return new Map(rows.map((row) => [row.id, homeWireForCaller(row, accessible).home_writable]));
}

/**
 * A package no principal in any organization may mutate: a SYSTEM one, synced
 * from `system-packages/` and owned by the platform. Both readers of the write
 * rule test it — the mutation route throws its own 403, the wire projection
 * answers `home_writable: false` — so it is stated once.
 */
function isSystemPackageRow(pkg: { source: string }): boolean {
  return pkg.source === "system";
}

/**
 * Does the caller hold `permission` in the package's HOME? — `<type>:<action>`
 * in the home space, the whole rule, with nothing beside it, and the predicate
 * behind every `home_*` answer and every `assertHomeAuthority` verdict.
 *
 * `accessible` is already the caller's standing in the organization that OWNS
 * the package: their own org everywhere except the cross-org fork reader,
 * which resolves the source org's spaces under their membership role there.
 *
 * `homeSpaceId` is typed nullable because the COLUMN is, and the two rows that
 * carry a NULL there — a system package, an inline run's shadow row
 * (`packages_org_package_has_home`) — are refused by every caller of this
 * function before it is reached. A NULL that got here anyway matches no
 * accessible space and answers `false`, which is the safe half.
 *
 * Exported because the home can MOVE between the moment a route authorizes and
 * the moment it writes: `POST …/shares` re-asks it against the home it has
 * LOCKED, inside the transaction that writes the offer
 * (`services/package-shares.ts`). It takes the home id rather than a Context so
 * a caller holding a locked row can ask about THAT row.
 */
export function holdsHomeAuthority(
  pkg: { homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
  permission: Permission,
): boolean {
  const home = accessible.find((space) => space.id === pkg.homeSpaceId);
  return home?.permissions.has(permission) ?? false;
}

/**
 * Does READING this package let the caller COPY it out (plan decision 12)?
 *
 * By default yes, which is what a reader can approximate by hand anyway. An
 * organization that sets `org_settings.restrict_package_copy` narrows the three
 * routes that hand over a whole package — `POST …/fork`,
 * `GET …/{version}/download` and `GET /api/agents/{scope}/{name}/bundle` — to
 * callers who hold `<type>:share` in the SOURCE's home space. Without that key,
 * personal spaces open "fork it into mine, then share it on" to every reader:
 * `share` would protect the link and not the content.
 *
 * No owner-or-admin fallback for a homeless package, because there is no such
 * package: `packages_org_package_has_home` (drizzle `0067`) makes a home
 * mandatory and the two rows it exempts are refused above. An owner or admin
 * governs a package by reaching its home space (RBAC spec §13.7).
 *
 * Three exemptions. SKILLS, in both settings: the CLI's skills sync downloads
 * them into a local checkout by design (`apps/cli/src/lib/skills-sync/plan.ts`).
 * RUNS, since a run's bundle is assembled server-side and never travels as a
 * copy. SYSTEM packages, stated HERE rather than left to the home rule — they
 * are readable in every space of every organization, so there is no owning
 * space for this setting to protect.
 *
 * The setting is read UNCACHED for the same reason the SSO gate is: a security
 * gate must not answer from a TTL.
 */
export async function assertPackageCopyAllowed(
  c: Context<AppEnv>,
  pkg: { id: string; type: PackageType; source: string; homeSpaceId: string | null },
  source: {
    orgId: string;
    accessible: Awaited<ReturnType<typeof packageAccessSpaces>>;
  },
): Promise<void> {
  if (pkg.type === "skill" || isSystemPackageRow(pkg)) return;
  // The SOURCE organization's setting, and the spaces the caller reaches THERE
  // — a fork may cross organizations, and it is the source's content being
  // protected.
  const settings =
    source.orgId === c.get("orgId")
      ? (c.get("orgSettings") ?? (await getOrgSettings(source.orgId)))
      : await getOrgSettings(source.orgId);
  if (settings.restrict_package_copy !== true) return;
  const permission = packagePermission(pkg.type, "share");
  if (holdsHomeAuthority(pkg, source.accessible, permission)) return;
  reportPermissionDenial(c, permission);
  throw new ApiError({
    status: 403,
    code: "package_copy_restricted",
    title: "Package Copy Restricted",
    detail:
      `This organization restricts copying packages out of the space that owns them. ` +
      `Copying '${pkg.id}' requires '${permission}' in its home space.`,
  });
}

/** Forking reads source bytes, including when the destination is another organization. */
export async function assertForkSourceAccess(c: Context<AppEnv>, packageId: string) {
  const [pkg] = await db
    .select({ orgId: packages.orgId })
    .from(packages)
    .where(and(eq(packages.id, packageId), notEphemeralFilter()))
    .limit(1);
  if (!pkg) throw notFound(`Package '${packageId}' not found`);
  if (!pkg.orgId || pkg.orgId === c.get("orgId")) {
    const orgId = c.get("orgId");
    const accessible = await packageAccessSpaces(c);
    const source = await assertCatalogPackageAccess(c, packageId);
    await assertPackageCopyAllowed(c, source, { orgId, accessible });
    return source;
  }
  // Only the user themselves may invoke their membership in another organization.
  if (!isUserPrincipal(c)) {
    throw notFound(`Package '${packageId}' not found`);
  }
  const membership = await getOrgMember(pkg.orgId, c.get("user").id);
  if (!membership) throw notFound(`Package '${packageId}' not found`);
  const standing = { orgId: pkg.orgId, orgRole: membership.role };
  const accessible = await packageAccessSpaces(c, standing);
  const source = await assertCatalogPackageAccess(c, packageId, standing);
  await assertPackageCopyAllowed(c, source, { orgId: pkg.orgId, accessible });
  return source;
}

/** Shared authorization for REST and MCP bundle validation/import, before metadata or writes. */
export async function authorizeBundlePackages(c: Context<AppEnv>, bundle: Bundle): Promise<void> {
  for (const [identity, pkg] of bundle.packages) {
    const parsed = parsePackageIdentity(identity);
    if (!parsed) throw invalidRequest(`Invalid package identity: ${identity}`);
    const packageId = parsed.packageId;
    if (isSystemPackage(packageId)) {
      const source = await assertCatalogPackageAccess(c, packageId);
      if (identity === bundle.root)
        await assertExistingPackageActivationAccess(c, packageId, source.type);
      continue;
    }
    const type = pkg.manifest.type;
    if (type !== "agent" && type !== "skill" && type !== "integration" && type !== "mcp-server") {
      throw invalidRequest(`Unknown package type '${String(type)}'`);
    }
    await makePermissionGuard(packagePermission(type, "write"))(c, async () => {});
    const [existing] = await db
      .select({ orgId: packages.orgId, type: packages.type })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);
    if (existing?.orgId === c.get("orgId")) {
      await assertPackageMutationAccess(c, packageId, "write");
      if (identity === bundle.root)
        await assertExistingPackageActivationAccess(c, packageId, existing.type);
    }
  }

  // Every package the bundle's manifests NAME but do not CARRY, checked with
  // the rule the package routes use ({@link assertPackageDependenciesAccessible}).
  //
  // The loop above authorizes what the bundle brings. A manifest may also point
  // OUTWARD — a declared dependency, or the `source.server.name` of a
  // `source.kind: "local"` integration — and `importBundle` writes
  // `draftManifest` straight from the archive, so an unchecked outward
  // reference is written verbatim and resolved at kickoff by
  // `integration-spawn-resolver.ts`, which asks the ORGANIZATION boundary and
  // nothing about placement. Without this pass, an archive was the way to name
  // a package the importer may not read — an mcp-server homed in somebody
  // else's personal space included (§3.6).
  //
  // References the bundle carries are excluded: those are the rows the loop
  // above already authorized, and they may not exist in the catalog yet.
  const carried = new Set<string>();
  for (const identity of bundle.packages.keys()) {
    const id = parsePackageIdentity(identity)?.packageId;
    if (id) carried.add(id);
  }
  const outward = new Map<PackageIdString, PackageType>();
  for (const [, pkg] of bundle.packages) {
    for (const ref of manifestPackageRefs(asRecord(pkg.manifest))) {
      if (!carried.has(ref.id)) outward.set(ref.id, ref.type);
    }
  }
  if (outward.size === 0) return;
  const checkedTypes = new Set<PackageType>();
  for (const type of outward.values()) {
    if (checkedTypes.has(type)) continue;
    checkedTypes.add(type);
    await makePermissionGuard(packagePermission(type, "read"))(c, async () => {});
  }
  const known = await db
    .select({ id: packages.id })
    .from(packages)
    .where(inArray(packages.id, [...outward.keys()]));
  // A reference to nothing stays the existing missing-dependency error; a
  // reference to something the caller cannot reach is hidden, as everywhere.
  for (const { id } of known) await assertCatalogPackageAccess(c, id);
}

/** `@scope/name`, the shape both `packages.id` and the catalog reads are typed with. */
type PackageIdString = `@${string}/${string}`;

/**
 * EVERY package this manifest names, as `{ id, type }` — `dependencies.*` AND
 * the one reference that lives outside that block.
 *
 * An integration with `source.kind: "local"` names its mcp-server in
 * `source.server.name` (AFPS §7.1), and `extractDependencies` does not see it:
 * it reads `dependencies.{skills,mcp_servers,integrations}` and nothing else.
 * That reference is not decorative — `integration-spawn-resolver.ts` resolves it
 * at kickoff and spawns THOSE bytes. Leaving it out of the access check made it
 * the one way to name a package the caller may not read: the spawn resolver
 * applies the ORGANIZATION boundary (`resolveMcpServerForSpawn` →
 * `resolvePublishedManifest(…, orgId, …)`) and asks nothing about placement, so
 * an mcp-server homed in somebody else's PERSONAL space — a 404 on every
 * package route, §3.6 — resolved and ran.
 */
const DEPENDENCY_GROUPS = [
  ["skills", "skill"],
  ["mcp_servers", "mcp-server"],
  ["integrations", "integration"],
] as const satisfies ReadonlyArray<readonly [string, PackageType]>;

function manifestPackageRefs(
  manifest: Record<string, unknown>,
): Array<{ id: PackageIdString; type: PackageType }> {
  // The NAMES, read tolerantly. `extractDependencies` validates the semver
  // range beside each one and THROWS on a bad one — right for a write path,
  // wrong here: whether a caller may read `@scope/server` does not depend on
  // the range written next to it, and letting a malformed range decide an
  // authorization answer turns a schema question into a 500. A name that
  // matches no catalog row grants nothing, which is the only outcome a
  // malformed one can reach.
  const refs: Array<{ id: PackageIdString; type: PackageType }> = [];
  const dependencies = asRecord(manifest.dependencies);
  for (const [group, type] of DEPENDENCY_GROUPS) {
    for (const name of Object.keys(asRecord(dependencies[group]))) {
      refs.push({ id: name as PackageIdString, type });
    }
  }
  const localServer = getLocalServerRef(manifest as unknown as IntegrationManifest);
  // `source.server.name` is a free-form string in the raw manifest; the schema
  // that validates the package has already refused anything that is not a
  // scoped name, and a reference that still does not match simply matches no
  // catalog row below.
  if (localServer) refs.push({ id: localServer.name as PackageIdString, type: "mcp-server" });
  return refs;
}

/** Caller-authored references need live source read access; unchanged references need no new scope. */
export async function assertPackageDependenciesAccessible(
  c: Context<AppEnv>,
  manifest: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): Promise<void> {
  const previousIds = new Set(manifestPackageRefs(previous).map((ref) => ref.id));
  const seen = new Set<string>();
  const references = manifestPackageRefs(manifest).filter((ref) => {
    if (previousIds.has(ref.id) || seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
  if (!references.length) return;
  const checked = new Set<string>();
  for (const reference of references) {
    if (checked.has(reference.type)) continue;
    checked.add(reference.type);
    await makePermissionGuard(packagePermission(reference.type, "read"))(c, async () => {});
  }
  const existing = await db
    .select({ id: packages.id })
    .from(packages)
    .where(
      inArray(
        packages.id,
        references.map((reference) => reference.id),
      ),
    );
  // Readiness keeps the existing missing-dependency errors; known but inaccessible sources are hidden.
  for (const { id } of existing) await assertCatalogPackageAccess(c, id);
}
