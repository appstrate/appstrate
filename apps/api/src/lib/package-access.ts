// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, runs, spacePackages, spaces } from "@appstrate/db/schema";
import { assertDependencyOverrideKeysDeclared } from "./launch-schemas.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { asRecord } from "@appstrate/core/safe-json";
import {
  VERSION_SELECTOR_DRAFT,
  VERSION_SELECTOR_PUBLISHED,
} from "../services/agent-version-resolver.ts";
import { getLatestVersionId } from "../services/package-versions.ts";
import {
  isPackageActiveHere,
  packagePlacementsInSpaces,
  type PlacementAuthority,
} from "../services/space-packages.ts";
import { activeHereSql } from "../services/package-activation.ts";
import { parsePackageIdentity, type Bundle } from "@appstrate/afps-runtime/bundle";
import {
  makePermissionGuard,
  packagePermission,
  packageSightPermissions,
  reportPermissionDenial,
  spacePackagePermission,
} from "@appstrate/core/permissions";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import { getOrgMember, getOrgSettings } from "../services/organizations.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { PackageHome } from "@appstrate/shared-types";
import { ORG_ROLES_WITH_FULL_ACCESS, type OrgRole } from "@appstrate/core/permissions";
import type { AppEnv } from "../types/index.ts";
import type { SpaceScope } from "./scope.ts";
import {
  callerPermissions,
  ceilingAllows,
  readsAgentContent,
  type Permission,
} from "./permissions.ts";
import { isUserPrincipal } from "./principal.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  credentialAdmitsSpace,
  credentialConfinedToSpaces,
} from "./view-as.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "./package-helpers.ts";
import { ApiError, forbidden, notFound, invalidRequest } from "./errors.ts";
import {
  callerReachableSpaces,
  credentialReachableSpaces,
  unnameableSpace,
  type ReachableSpace,
} from "./reachable-spaces.ts";
import {
  placedSpaceIds,
  placementReadFilter,
  placementRowJoin,
} from "../services/package-placement.ts";

/**
 * The read guard of the three agent routes `agents:run` also opens: the list,
 * the detail, and the resolved model the launch form reads (RBAC spec §3.4).
 * Every other agent surface keeps its `agents:read` / `agents:write` guard.
 */
export const requireAgentRead = requireAnyPermission(packageSightPermissions("agent"));

/** `readsAgentContent`, negated, for the request's own space. */
export function agentReadIsSummary(c: Context<AppEnv>): boolean {
  return !readsAgentContent(callerPermissions(c));
}

/**
 * Existing catalog imports need the target's activation grant unless the
 * package is already active here ({@link activeHereSql}): `importBundle` ends
 * in `activatePackage`, so a placed-but-off row must not be switched back on
 * without the grant. A default-on package waives it.
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
    // Required by `activeHereSql`: without it every package falls back to the default.
    .leftJoin(spacePackages, placementRowJoin(packages.id, target))
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

/** One space of the caller's reach, with their effective permissions in it. */
export type PackageAccessSpace = Pick<
  ReachableSpace,
  "id" | "name" | "isDefault" | "visibility" | "defaultRole" | "ownerUserId"
> & { permissions: ReadonlySet<string> };

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
export async function packageAccessSpaces(
  c: Context<AppEnv>,
  foreign?: ForeignOrgStanding,
): Promise<PackageAccessSpace[]> {
  const orgId = foreign?.orgId ?? c.get("orgId");
  // Memoized per request by `callerReachableSpaces`.
  if (c.get("principalKind") !== "end_user") {
    return callerReachableSpaces(c, orgId, foreign?.orgRole ?? callerOrgRole(c, orgId));
  }
  // An end-user acts in its own space only (RBAC spec §7.2), with the request's set there.
  const spaceId = c.get("credentialSpaceId");
  if (spaceId === undefined) return [];
  const [space] = await db
    .select({
      id: spaces.id,
      name: spaces.name,
      isDefault: spaces.isDefault,
      visibility: spaces.visibility,
      defaultRole: spaces.defaultRole,
      ownerUserId: spaces.ownerUserId,
    })
    .from(spaces)
    .where(and(eq(spaces.id, spaceId), eq(spaces.orgId, orgId)));
  return space ? [{ ...space, permissions: callerPermissions(c) }] : [];
}

/**
 * The reach of a WRITE that places a package outside its home or withdraws it, judged in the home
 * while it acts in the target: the credential's own ({@link credentialReachableSpaces}), so a
 * credential bound to a set judges it the same whichever of its spaces the call entered. Every
 * read keeps {@link packageAccessSpaces}; so does an end-user (its own space).
 */
export function placementAccessSpaces(c: Context<AppEnv>): Promise<PackageAccessSpace[]> {
  return c.get("principalKind") === "end_user"
    ? packageAccessSpaces(c)
    : credentialReachableSpaces(c, c.get("orgId"));
}

/**
 * Does the package's placement grant read from these spaces? The in-memory form
 * of `placementReadFilter` (RBAC spec §6.9, §6.10): homed there or placed there
 * (`placedIn`: a row, or an offer to the organization). `<type>:read` stays with each reader. Read only: running also needs
 * activity ({@link agentExecutionBlock}).
 */
export function placementGrantsRead(
  pkg: { homeSpaceId: string | null },
  placedIn: Iterable<string>,
  readable: ReadonlySet<string>,
): boolean {
  if (pkg.homeSpaceId !== null && readable.has(pkg.homeSpaceId)) return true;
  for (const spaceId of placedIn) if (readable.has(spaceId)) return true;
  return false;
}

/** Placement only. The caller checks the org boundary and the required permission. */
export async function isPackageReadableInSpace(
  spaceId: string,
  packageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaceId))
    .where(and(eq(packages.id, packageId), notEphemeralFilter(), placementReadFilter(spaceId)))
    .limit(1);
  return !!row;
}

/** The permission half of package reach, shared by the catalog, home and typed detail. */
function spaceIdsWithSight(type: PackageType, accessible: readonly PackageAccessSpace[]) {
  const sight = packageSightPermissions(type);
  return accessible
    .filter((space) => sight.some((permission) => space.permissions.has(permission)))
    .map((space) => space.id);
}

/** All detail placements the caller can read, and the active subset. */
export async function packageDetailSpaces(
  orgId: string,
  packageId: string,
  type: PackageType,
  accessible: readonly PackageAccessSpace[],
) {
  const rows = await packagePlacementsInSpaces(
    orgId,
    packageId,
    spaceIdsWithSight(type, accessible),
    type,
  );
  return {
    read_space_ids: rows.map((row) => row.id),
    space_ids: rows.filter((row) => row.active).map((row) => row.id),
  };
}

/**
 * True when `packageId` is an ephemeral inline shadow of this org with a run in
 * this space that `visibility` admits — the one way a shadow, which no
 * placement reaches, is readable. A shadow is 1:1 with its run, so its read
 * rule is the run's: pass `runVisibilityFilter(c)` (`lib/run-visibility.ts`).
 */
export async function isInlineShadowRunReadable(
  orgId: string,
  spaceId: string,
  packageId: string,
  visibility: SQL | undefined,
): Promise<boolean> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(packages, eq(packages.id, runs.packageId))
    .where(
      and(
        eq(runs.packageId, packageId),
        eq(runs.orgId, orgId),
        eq(runs.spaceId, spaceId),
        eq(packages.orgId, orgId),
        eq(packages.ephemeral, true),
        visibility,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Why a package may NOT execute in a space — `null` when it may.
 *
 * `"not_placed"` beats `"not_active"`: a space that holds no placement is told
 * nothing about a switch it was never entitled to throw.
 */
export type AgentExecutionBlock = "not_placed" | "not_active";

/**
 * The execution predicate: may this package run in this space? Placed here
 * ({@link isPackageReadableInSpace}) AND active here (`isPackageActiveHere`).
 * Shared by `requireActiveAgent`, the remote-run resolver and the scheduler
 * tick. A verdict, not a throw: each caller words its own refusal. The org
 * boundary is `isPackageActiveHere`'s.
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
  return assertPackageReachable(c, packageId, packageAccessSpaces, source);
}

/** {@link assertCatalogPackageAccess} over {@link placementAccessSpaces}: the activation door, which may place. */
export async function assertPackageReachableForPlacement(c: Context<AppEnv>, packageId: string) {
  return assertPackageReachable(c, packageId, placementAccessSpaces);
}

/** The one reachability read; the callers differ only in the spaces the credential reaches. */
async function assertPackageReachable(
  c: Context<AppEnv>,
  packageId: string,
  reach: (c: Context<AppEnv>, source?: ForeignOrgStanding) => Promise<PackageAccessSpace[]>,
  source?: ForeignOrgStanding,
) {
  const sourceOrgId = source?.orgId ?? c.get("orgId");
  const [pkg, accessible, placedIn] = await Promise.all([
    loadPackageRow(packageId, sourceOrgId),
    reach(c, source),
    loadPlacementSpaces(packageId, sourceOrgId),
  ]);
  assertPackageIsReachable(packageId, pkg, placedIn, accessible);
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
 * Every space of `orgId` the package is placed in beyond its home — a
 * `space_packages` row there, or every space when the package is offered to the
 * organization — the placements {@link placementGrantsRead} needs, the home
 * being a column on the package row itself.
 *
 * Split out from the row read because the write path never needs it: authority
 * is the home alone, so the placements are loaded only when a refusal has to
 * decide between 403 and 404.
 */
async function loadPlacementSpaces(packageId: string, orgId: string): Promise<string[]> {
  return placedSpaceIds(orgId, packageId);
}

/**
 * 404 unless the caller may know this id exists — {@link placementGrantsRead}
 * + `<type>:read`.
 *
 * PLACEMENT is the whole rule, with no exception beside it. A package of the
 * organization is always homed in one of its spaces
 * (`packages_org_package_has_home`), so reaching it means reaching that space
 * or one the package is placed in; an owner or admin gets there because they
 * reach every team space, not through an authority of their own. That is what
 * keeps a draft sitting switched off in a member's PERSONAL space out of an
 * admin's reach, which is the one thing §3.6 refuses.
 */
function assertPackageIsReachable(
  packageId: string,
  pkg: PackageAccessRow,
  placedIn: readonly string[],
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): void {
  const readable = new Set(spaceIdsWithSight(pkg.type, accessible));
  if (
    !(isSystemPackageRow(pkg) ? readable.size > 0 : placementGrantsRead(pkg, placedIn, readable))
  ) {
    throw notFound(`Package '${packageId}' not found`);
  }
}

/**
 * A package's home and its reach, resolved across EVERY space the caller
 * reaches rather than the one in `X-Space-Id` — `GET …/home`.
 *
 * That is the question the per-type detail cannot answer: it reads from the
 * current space alone, so a package homed in the caller's personal space and
 * placed nowhere else is a 404 from every team space. A client holding only an id
 * — the CLI, pointed at a working folder — asks here which space to address.
 *
 * `null` exactly when {@link assertCatalogPackageAccess} would refuse, from the
 * same predicate. `home_*` is {@link homeWireForCaller}, so a home the caller
 * does not reach stays `null` even when a share makes the package readable;
 * `read_space_ids` puts the home first when it is one of them, then sorts by
 * id so the answer does not depend on row order.
 */
export async function resolvePackageHome(
  c: Context<AppEnv>,
  packageId: string,
): Promise<PackageHome | null> {
  const orgId = c.get("orgId");
  const [pkg, accessible] = await Promise.all([
    findPackageRow(packageId, orgId),
    packageAccessSpaces(c),
  ]);
  if (!pkg) return null;
  const { read_space_ids: readSpaceIds } = await packageDetailSpaces(
    orgId,
    packageId,
    pkg.type,
    accessible,
  );
  if (!readSpaceIds.length) return null;
  const rank = (id: string) => (id === pkg.homeSpaceId ? 0 : 1);
  readSpaceIds.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
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
 * The home rule as a boolean: may the caller write (and so run the draft of)
 * this package? Module-local; callers go through {@link assertDraftSelectorAllowed},
 * {@link assertDependencyDraftOverridesAllowed} or {@link defaultDefinitionSelector}.
 * `false`, never a throw.
 */
async function holdsPackageWriteAuthority(c: Context<AppEnv>, packageId: string): Promise<boolean> {
  const orgId = c.get("orgId");
  const pkg = await findPackageRow(packageId, orgId);
  if (!pkg) return false;
  if (isSystemPackageRow(pkg) || pkg.orgId !== orgId) return false;
  const accessible = await packageAccessSpaces(c);
  return holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, "write"));
}

/**
 * {@link assertPackageShareAccessForPlacement} as a question, for bundle import: place the
 * root here when the caller may ({@link callerPlacementAuthority}), else `null`
 * and `root_active: false`.
 */
export async function heldPlacementAuthority(
  c: Context<AppEnv>,
  packageId: string,
): Promise<PlacementAuthority | null> {
  const orgId = c.get("orgId");
  const pkg = await findPackageRow(packageId, orgId);
  if (!pkg || isSystemPackageRow(pkg) || pkg.orgId !== orgId) return null;
  const authority = await callerPlacementAuthority(c, pkg.type);
  return authority.authorizeHome(pkg.homeSpaceId) ? authority : null;
}

/**
 * Refuse a `version=draft` launch by a caller who cannot WRITE the package —
 * `403 draft_not_writable` (plan decision 4).
 *
 * A no-op for every other selector, the omitted one included: an omitted
 * selector is the published `latest`, which anybody who may run the
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

/** {@link assertPackageShareAccess} for a placement WRITE, over {@link placementAccessSpaces}. */
export async function assertPackageShareAccessForPlacement(
  c: Context<AppEnv>,
  packageId: string,
): Promise<PackageAccessRow> {
  return assertHomeAuthority(c, packageId, "share", placementAccessSpaces);
}

/** The caller as a placer: `shared_by` plus the share rule as a predicate `placePackage` re-asks against the locked home. */
export async function callerPlacementAuthority(
  c: Context<AppEnv>,
  type: PackageType,
): Promise<PlacementAuthority> {
  const accessible = await placementAccessSpaces(c);
  const permission = packagePermission(type, "share");
  return {
    sharedBy: c.get("user").id,
    authorizeHome: (homeSpaceId) => holdsHomeAuthority({ homeSpaceId }, accessible, permission),
  };
}

/** An organization owner or admin acting through a user credential unconfined to spaces: the role half of the offer door. */
export function callerAdministersOrg(c: Context<AppEnv>): boolean {
  return (
    isUserPrincipal(c) &&
    !credentialConfinedToSpaces(c) &&
    (ORG_ROLES_WITH_FULL_ACCESS as readonly OrgRole[]).includes(callerOrgRole(c))
  );
}

/** {@link callerAdministersOrg}, and the credential's scope ceiling leaves `<type>:share` in reach (RBAC spec §7.1). */
export function callerMayOffer(c: Context<AppEnv>, type: PackageType): boolean {
  return callerAdministersOrg(c) && ceilingAllows(c, packagePermission(type, "share"));
}

/**
 * Authority to OFFER a package to its organization, or to withdraw the offer
 * (RBAC spec §6.10): an owner or admin of the organization, acting with a user
 * credential unconfined to spaces whose scope ceiling leaves `<type>:share`,
 * AND for a package homed in a space, `<type>:share` in that home. A system
 * package has no home, so the role and the ceiling alone decide. The role is asked before the package is read, so a member
 * learns nothing about which ids exist. Returns the loaded row and the home
 * rule as a predicate, which the offer service re-asks against the locked home.
 */
export async function assertPackageOfferAccess(
  c: Context<AppEnv>,
  packageId: string,
): Promise<{
  pkg: PackageAccessRow;
  authorizeHome: PlacementAuthority["authorizeHome"];
}> {
  const orgId = c.get("orgId");
  if (!callerAdministersOrg(c)) {
    throw forbidden(
      "Offering a package to the organization requires an owner or admin user credential, unconfined to spaces.",
    );
  }
  const pkg = await loadPackageRow(packageId, orgId);
  if (!callerMayOffer(c, pkg.type)) {
    throw forbidden(
      `Offering '${packageId}' to the organization is outside this credential's scope: it needs '${packagePermission(pkg.type, "share")}'.`,
    );
  }
  if (isSystemPackageRow(pkg)) return { pkg, authorizeHome: () => true };
  const accessible = await placementAccessSpaces(c);
  const share = packagePermission(pkg.type, "share");
  const authorizeHome: PlacementAuthority["authorizeHome"] = (homeSpaceId) =>
    holdsHomeAuthority({ homeSpaceId }, accessible, share);
  if (!authorizeHome(pkg.homeSpaceId)) {
    await refuseHomeAuthority(
      c,
      packageId,
      pkg,
      accessible,
      share,
      `Offering '${packageId}' to the organization requires '${share}' in its home space.`,
    );
  }
  return { pkg, authorizeHome };
}

/** Which side's authority withdrew a placement — recorded on `package.unshared`. */
export type PlacementRemovalAuthority = "home" | "recipient";

/**
 * Authority to withdraw a placement from `targetSpaceId`, held by either side
 * (RBAC spec §6.10): the home's `<type>:share`, or the target's deactivation
 * grant (waived in the caller's own personal space). Same 404/403 split as
 * {@link assertPackageShareAccess}. Returns the rule as a predicate over the
 * home, which `revokePackageShare` re-asks against the locked home.
 */
export async function assertPlacementRemovalAccess(
  c: Context<AppEnv>,
  packageId: string,
  targetSpaceId: string,
): Promise<{
  pkg: PackageAccessRow;
  authorityFor: (homeSpaceId: string | null) => PlacementRemovalAuthority | null;
}> {
  // The target is a space the credential may name, whichever side's authority acts: home
  // authority reaches the package, not every space it could be placed in.
  if (!credentialAdmitsSpace(c, targetSpaceId)) throw unnameableSpace(c, targetSpaceId);
  const { pkg, accessible } = await loadGovernedPackage(
    c,
    packageId,
    "share",
    placementAccessSpaces,
  );
  const share = packagePermission(pkg.type, "share");
  const target = accessible.find((space) => space.id === targetSpaceId);
  const ownerId = callerPersonalOwnerId(c, c.get("orgId"));
  const recipientSide =
    target !== undefined &&
    ((ownerId !== null && target.ownerUserId === ownerId) ||
      target.permissions.has(spacePackagePermission(pkg.type, "deactivate")));
  const authorityFor = (homeSpaceId: string | null): PlacementRemovalAuthority | null =>
    holdsHomeAuthority({ homeSpaceId }, accessible, share)
      ? "home"
      : recipientSide
        ? "recipient"
        : null;
  const authority = authorityFor(pkg.homeSpaceId);
  if (authority === "recipient") {
    // No home authority: an unreachable package must answer a plain 404.
    assertPackageIsReachable(
      packageId,
      pkg,
      await loadPlacementSpaces(packageId, c.get("orgId")),
      accessible,
    );
  } else if (authority === null) {
    await refuseHomeAuthority(
      c,
      packageId,
      pkg,
      accessible,
      share,
      `Withdrawing '${packageId}' from that space requires '${share}' in its home space, or '${spacePackagePermission(pkg.type, "deactivate")}' in that space.`,
    );
  }
  return { pkg, authorityFor };
}

/** The spaces the home rule reads: {@link packageAccessSpaces}, or {@link placementAccessSpaces} for a placement write. */
type GovernedReach = (c: Context<AppEnv>) => Promise<PackageAccessSpace[]>;

/** The home rule itself, for each of the three verbs that ask it. */
async function assertHomeAuthority(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete" | "share",
  reach: GovernedReach = packageAccessSpaces,
): Promise<PackageAccessRow> {
  const { pkg, accessible } = await loadGovernedPackage(c, packageId, action, reach);
  const permission = packagePermission(pkg.type, action);
  if (holdsHomeAuthority(pkg, accessible, permission)) return pkg;
  const verb = action === "share" ? "Sharing" : "Modifying";
  return refuseHomeAuthority(
    c,
    packageId,
    pkg,
    accessible,
    permission,
    `${verb} '${packageId}' requires '${permission}' in its home space.`,
  );
}

/** An organization package and the caller's reach — a system one is refused outright. */
async function loadGovernedPackage(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete" | "share",
  reach: GovernedReach,
): Promise<{ pkg: PackageAccessRow; accessible: PackageAccessSpace[] }> {
  const orgId = c.get("orgId");
  const [pkg, accessible] = await Promise.all([loadPackageRow(packageId, orgId), reach(c)]);
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
  return { pkg, accessible };
}

/** Refusal: 404 when the id is unreachable (no existence oracle), else 403. Only this path loads the placements. */
async function refuseHomeAuthority(
  c: Context<AppEnv>,
  packageId: string,
  pkg: PackageAccessRow,
  accessible: PackageAccessSpace[],
  permission: Permission,
  detail: string,
): Promise<never> {
  assertPackageIsReachable(
    packageId,
    pkg,
    await loadPlacementSpaces(packageId, c.get("orgId")),
    accessible,
  );
  reportPermissionDenial(c, permission);
  throw forbidden(detail);
}

/** The home's id when the caller reaches that space, `null` otherwise (never the raw column). */
export function visibleHomeSpaceId(
  pkg: { homeSpaceId: string | null },
  accessible: readonly { id: string }[],
): string | null {
  return pkg.homeSpaceId !== null && accessible.some((space) => space.id === pkg.homeSpaceId)
    ? pkg.homeSpaceId
    : null;
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
  const system = isSystemPackageRow(pkg);
  const holds = (action: "write" | "delete" | "share") =>
    !system && holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, action));
  return {
    home_space_id: visibleHomeSpaceId(pkg, accessible),
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
 * Exported so the placement doors can re-ask it against the locked home.
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
 * Three exemptions. SKILLS, in both settings: the CLI's `code sync` downloads
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
    if (type !== "agent" && type !== "skill" && type !== "integration") {
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
  // OUTWARD — a declared dependency — and `importBundle` writes
  // `draftManifest` straight from the archive, so an unchecked outward
  // reference is written verbatim. Without this pass, an archive was the way
  // to name a package the importer may not read (§3.6).
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
 * EVERY package this manifest names, as `{ id, type }`, read from
 * `dependencies.{skills,integrations}`. A local MCP server is declared inline
 * on its integration (`source.server`), so it names no package.
 */
const DEPENDENCY_GROUPS = [
  ["skills", "skill"],
  ["integrations", "integration"],
] as const satisfies ReadonlyArray<readonly [string, PackageType]>;

function manifestPackageRefs(
  manifest: Record<string, unknown>,
): Array<{ id: PackageIdString; type: PackageType }> {
  // The NAMES, read tolerantly. `extractDependencies` validates the semver
  // range beside each one and THROWS on a bad one — right for a write path,
  // wrong here: whether a caller may read `@scope/skill` does not depend on
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
