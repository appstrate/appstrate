// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageShares, spacePackages, spaces } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { assertDependencyOverrideKeysDeclared } from "./launch-schemas.ts";
import { isSystemPackage } from "../services/system-packages.ts";
import { getLocalServerRef } from "../services/integration-manifest-helpers.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import {
  VERSION_SELECTOR_DRAFT,
  VERSION_SELECTOR_PUBLISHED,
} from "../services/agent-version-resolver.ts";
import { getLatestVersionId } from "../services/package-versions.ts";
import { isPackageActiveHere } from "../services/space-packages.ts";
import { parsePackageIdentity, type Bundle } from "@appstrate/afps-runtime/bundle";
import { makePermissionGuard, reportPermissionDenial } from "@appstrate/core/permissions";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import { getOrgMember, getOrgSettings } from "../services/organizations.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
import type { SpaceScope } from "./scope.ts";
import { callerPermissions, type Permission } from "./permissions.ts";
import {
  callerOrgRole,
  callerPersonalOwnerId,
  callerSpaceMemberships,
  effectiveInSpace,
} from "./view-as.ts";
import { resolveSpaceRole } from "./space-role.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "./package-helpers.ts";
import { ApiError, forbidden, notFound, invalidRequest } from "./errors.ts";

const PACKAGE_RESOURCES = {
  agent: "agents",
  skill: "skills",
  integration: "integrations",
  "mcp-server": "mcp-servers",
} as const;

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
 * of that rule (RBAC spec §3.4).
 *
 * For an agent it is a disjunction: `agents:run` opens the list, the detail and
 * the resolved model the launch form reads, in a summary projection. So a
 * `runner` reaches an agent, and every predicate that asks "may this caller
 * know this package exists" — {@link requireAgentRead} as a route guard,
 * {@link assertPackageIsReachable} as the 403-vs-404 decision — has to ask the
 * same question. When they disagreed, a `runner` attempting a write got a 404
 * on an agent it was, at that same moment, allowed to read.
 *
 * Every other type has one read permission and this collapses to it.
 */
function packageReadPermissions(type: PackageType): readonly Permission[] {
  const read = packagePermission(type, "read");
  return type === "agent" ? [read, "agents:run"] : [read];
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

/** Existing catalog imports must hold the target's activation grant before placing it. */
export async function assertExistingPackageActivationAccess(
  c: Context<AppEnv>,
  packageId: string,
  type: PackageType,
) {
  const target = c.get("space")?.id ?? c.get("spaceId");
  const [placement] = await db
    .select({ packageId: spacePackages.packageId })
    .from(spacePackages)
    .where(and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, target)))
    .limit(1);
  if (!placement)
    await makePermissionGuard(spacePackagePermission(type, "activate"))(c, async () => {});
}

/**
 * Resolve once for catalog listings and cross-space package operations. The org
 * role and the memberships are the CALLER's standing, which a preview replaces
 * — otherwise the catalog answers with the previewing admin's reach.
 */
export async function packageAccessSpaces(
  c: Context<AppEnv>,
  orgId = c.get("orgId"),
  orgRole = callerOrgRole(c, orgId),
) {
  const callerId = callerPersonalOwnerId(c, orgId);
  const [rows, memberships] = await Promise.all([
    db
      .select({
        id: spaces.id,
        name: spaces.name,
        isDefault: spaces.isDefault,
        visibility: spaces.visibility,
        defaultRole: spaces.defaultRole,
        ownerUserId: spaces.ownerUserId,
      })
      .from(spaces)
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
      ),
    c.get("endUser") && !c.get("orgRole")
      ? Promise.resolve(new Map())
      : callerSpaceMemberships(c, orgId),
  ]);
  return rows.flatMap((space) => {
    if (c.get("endUser") && !c.get("orgRole")) {
      return space.id === c.get("spaceId") ? [{ ...space, permissions: callerPermissions(c) }] : [];
    }
    const ref = resolveSpaceRole(orgRole, space, memberships.get(space.id) ?? null, callerId);
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
 * Does a package's PLACEMENT grant read from these spaces?
 *
 * One rule, one place (RBAC spec §6.9, §6.10): a package is readable where it
 * is HOMED and where it is SHARED. Exactly TWO placements. The home is a grant
 * of its own: a draft nobody has offered yet is readable where it lives, and an
 * author does not lose sight of their own package because a space switched off
 * it. Without it, write authority would exceed read access — a builder able to
 * `PUT` a package they cannot `GET`. The SHARE half is the audience rule, and
 * it has to grant read BEFORE anything is switched on: an offer the recipient
 * has not taken up still shows them its name, its description and the switch
 * that would activate it, which is only possible because the offer alone makes
 * the package readable.
 *
 * A PLACEMENT ROW is deliberately not a third one. It is the only candidate
 * that would answer "why does this space see this package" without consulting
 * `<type>:share`: a builder of B who reads A's package anywhere would activate
 * it in B and hand B a placement A granted to nobody. Activating is the act
 * of TAKING an offer — `activatePackage` requires `home ∨ shared` before it
 * writes anything — so a placement row is a placement's consequence and never
 * its source.
 *
 * The readers of this rule differ only in the set they compare against: the
 * org-wide catalog check below, the current-space gate of the package read
 * routes ({@link isPackageReadableInSpace}), the library listing, and the
 * per-type index listing (`listOrgItems`, which expresses it in SQL). Holding
 * `<type>:read` in one of those spaces is the other half of the rule and stays
 * with each reader.
 *
 * READ only. RUNNING a package asks this AND one more: {@link
 * agentExecutionBlock} wants it placed here *and* ACTIVE here — the placement
 * row's `enabled`, or the deployment's default where there is no row
 * (`services/package-activation.ts`). That is why a share is not an
 * activation: an agent runs with the recipient's credentials, so the recipient
 * switches it on themselves.
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
    .leftJoin(
      packageShares,
      and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, spaceId)),
    )
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
 * (`services/registry-run-resolver.ts`, behind `POST /api/runs/remote`, which
 * takes a package id straight from the caller) and the scheduler tick, which
 * fires on its own with no request to refuse.
 *
 * The activation half ALONE would let an ORPHAN placement — a `space_packages`
 * row with neither a home nor a share behind it, the residue
 * `scripts/migration/0016` repairs — execute from a cron in a space every HTTP
 * door refuses to serve it to. A cron is the one caller nobody is watching,
 * which is exactly why it must not be the permissive one.
 *
 * A VERDICT rather than a throw: the three callers render the refusal on their
 * own channels — an RFC-9457 404 with a code at the HTTP door, the resolver's
 * own 404 pair, a visible failed run with the schedule left ARMED at the tick
 * — and folding their wording into one shared `ApiError` would tell a schedule
 * to "pick a different space". The RULE is shared; the sentence each caller
 * shows is its own.
 *
 * Both halves are read in parallel: they are independent rows, and the tick
 * pays for this on every fire.
 *
 * Adds no `orgId` predicate of its own: `isPackageActiveHere` carries the org
 * boundary in its own query, and every caller has already loaded the package
 * under it (`getPackage(packageId, orgId)`).
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

/** Catalog reachability permits copying between accessible spaces, never guessing a private id. */
export async function assertCatalogPackageAccess(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
  sourceOrgId: string = c.get("orgId"),
) {
  const [pkg, accessible, sharedIn] = await Promise.all([
    loadPackageRow(packageId, sourceOrgId),
    resolvedSpaces ?? packageAccessSpaces(c),
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
  const opens = packageReadPermissions(pkg.type);
  const permitted = accessible.filter((space) =>
    opens.some((permission) => space.permissions.has(permission)),
  );
  const readable = new Set(permitted.map((space) => space.id));
  if (
    permitted.length === 0 ||
    (pkg.source !== "system" && !placementGrantsRead(pkg, sharedIn, readable))
  ) {
    throw notFound(`Package '${packageId}' not found`);
  }
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
 * API key to its own space. A second check against the current space would turn
 * the rule into "home AND wherever I am browsing from", which is what made a
 * builder's own package unwritable from a space where they only read.
 *
 * Returns the loaded row so a caller that has to act on it does not read it again.
 *
 * @see docs/architecture/RBAC_PERMISSIONS_SPEC.md §6.9
 */
export async function assertPackageMutationAccess(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete",
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<PackageAccessRow> {
  return assertHomeAuthority(c, packageId, action, resolvedSpaces);
}

/**
 * The SAME rule as {@link assertPackageMutationAccess}'s `write`, asked as a
 * question instead of a refusal — and the ONE predicate behind every "may this
 * caller run the DRAFT" decision (plan decision 4).
 *
 * A draft is the author's working copy: it executes for whoever can WRITE the
 * package, wherever they launch it from, and for nobody else. That is not a new
 * rule, it is the write rule read in a place that must not throw — the run
 * routes, the schedules, the readiness endpoint and the detail page each answer
 * something of their own (a `403 draft_not_writable`, a published fallback, a
 * projection) and none of them wants this function's 404/403 split. Stating it
 * as a boolean here is what keeps the four of them from each re-deriving "who
 * owns the draft" and drifting apart.
 *
 * `false`, never a throw, for every refusal the assert would spell out: a
 * package the org cannot see, a system package (nobody writes those), a home
 * the caller does not govern.
 *
 * Module-local on purpose. Every caller outside this file reaches it through
 * one of the three wordings below — {@link assertDraftSelectorAllowed},
 * {@link assertDependencyDraftOverridesAllowed},
 * {@link defaultDefinitionSelector} — so a route cannot invent a fourth way of
 * spelling the same refusal.
 */
async function holdsPackageWriteAuthority(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<boolean> {
  const orgId = c.get("orgId");
  const pkg = await findPackageRow(packageId, orgId);
  if (!pkg) return false;
  if (isSystemPackageRow(pkg) || pkg.orgId !== orgId) return false;
  const accessible = resolvedSpaces ?? (await packageAccessSpaces(c));
  return holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, "write"));
}

/**
 * The SAME rule as {@link assertPackageShareAccess}, asked as a question — for
 * the one caller that has to CHOOSE rather than refuse: a bundle import whose
 * root already lives in another space activates it with the offer when the
 * caller may make one, and reports `root_active: false` when they may not.
 *
 * `false`, never a throw, for every refusal the assert would spell out.
 */
export async function holdsPackageShareAuthority(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<boolean> {
  const orgId = c.get("orgId");
  const pkg = await findPackageRow(packageId, orgId);
  if (!pkg) return false;
  if (isSystemPackageRow(pkg) || pkg.orgId !== orgId) return false;
  const accessible = resolvedSpaces ?? (await packageAccessSpaces(c));
  return holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, "share"));
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
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<void> {
  if (selector?.trim() !== VERSION_SELECTOR_DRAFT) return;
  if (await holdsPackageWriteAuthority(c, packageId, resolvedSpaces)) return;
  throw draftNotWritable(packageId);
}

/**
 * WHICH definition a READ of a package renders when the caller named none —
 * the agent detail page, its readiness badge and the input-settings editor,
 * which must all judge the same bytes or the badge contradicts the form.
 *
 * Reading is not executing (RBAC spec §6.10). An author reads their DRAFT,
 * because that is the copy they are editing. Everybody else reads the latest
 * PUBLISHED version — unless nothing is published, in which case the draft is
 * the only definition that exists and hiding it would 404 a page the package
 * list has just linked to. The refusal belongs to the LAUNCH, which keeps
 * answering `404 no_published_version` for an omitted selector, and the wire
 * carries `definition` so the reader is told which of the two they are looking
 * at rather than inferring it.
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
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<{
  selector: typeof VERSION_SELECTOR_DRAFT | typeof VERSION_SELECTOR_PUBLISHED;
  writable: boolean;
}> {
  if (agent.source === "system") return { selector: VERSION_SELECTOR_PUBLISHED, writable: false };
  const writable = await holdsPackageWriteAuthority(c, agent.id, resolvedSpaces);
  if (writable) return { selector: VERSION_SELECTOR_DRAFT, writable };
  const published = await getLatestVersionId(agent.id);
  return { selector: published ? VERSION_SELECTOR_PUBLISHED : VERSION_SELECTOR_DRAFT, writable };
}

/**
 * The same refusal, applied to every DEPENDENCY a launch opts into its working
 * copy — `dependency_overrides: { "@acme/skill": "draft" }` on the run route,
 * the remote-run route and both schedule writes.
 *
 * `version=draft` and a dependency override spelled `draft` are ONE act: they
 * both execute an unpublished working copy, and the authority that decides is
 * the authority over THAT package — the overridden skill, not the agent that
 * declares it. Without this, a caller refused the agent's own draft still ran
 * every declared dependency's draft in the same request, which is the same rule
 * unapplied on a second axis.
 *
 * FORM FIRST, and that is why the effective manifest is a parameter rather than
 * a concern left downstream: a key naming no declared dependency is a
 * malformed request, not an unauthorized one, and judging authority over it
 * answered `403 draft_not_writable` for an act the launch would never have
 * performed — a refusal that names the wrong problem and sends its reader after
 * a grant they do not need. `assertDependencyOverrideKeysDeclared` runs first,
 * here, so no caller can order the two wrong.
 *
 * Non-`draft` values are version specs and stay a pure value concern: they can
 * only name something the author already published.
 */
export async function assertDependencyDraftOverridesAllowed(
  c: Context<AppEnv>,
  overrides: Readonly<Record<string, string>> | null | undefined,
  /** The manifest the launch will EXECUTE — a draft and a published version do not declare the same dependencies. */
  manifest: Record<string, unknown>,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<void> {
  assertDependencyOverrideKeysDeclared(manifest, overrides);
  if (!overrides) return;
  const accessible = resolvedSpaces ?? (await packageAccessSpaces(c));
  for (const [dependencyId, selector] of Object.entries(overrides)) {
    await assertDraftSelectorAllowed(c, dependencyId, selector, accessible);
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
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<PackageAccessRow> {
  return assertHomeAuthority(c, packageId, "share", resolvedSpaces);
}

/** The home rule itself, for each of the three verbs that ask it. */
async function assertHomeAuthority(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete" | "share",
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<PackageAccessRow> {
  const orgId = c.get("orgId");
  const [pkg, accessible] = await Promise.all([
    loadPackageRow(packageId, orgId),
    resolvedSpaces ?? packageAccessSpaces(c),
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
 * The two `home_*` fields EVERY package read emits — one contract, computed
 * once, for `AgentDetail`, `OrgPackageItem`, `OrgPackageItemDetail` and the
 * library listing.
 *
 * `home_space_id` is the home's id **only when the caller reaches that space**,
 * and `null` otherwise. The raw column cannot go on the wire: a package homed in
 * a member's PERSONAL space is legitimately readable by everyone it is
 * placed for, and emitting its home would hand each of them the id of a
 * space §3.6 says does not exist for them. `null` therefore means "not a space
 * you can see", and nothing downstream needs more than that: what a reader
 * actually wants to know is whether they may WRITE, which is the second field.
 *
 * `home_writable` is that answer, and it is `assertPackageMutationAccess`'s
 * WHOLE rule, not just its home half: a SYSTEM package is refused there before
 * the home is ever consulted, so it answers `false` here too however much
 * authority the caller holds. It used to answer `true` to owners and admins on
 * a system package the write route refuses, which is a button that 403s.
 *
 * It is computed for the type's `write`; the SPA gates delete and move on it
 * too, and the server still checks `<type>:delete` in its own right (they
 * diverge only under a custom role that grants one without the other, where the
 * API refuses and the UI over-offered).
 *
 * `home_shareable` is the same answer for the type's `share` (RBAC spec §6.10)
 * — what the "Share…" action is gated on. It is a field of its own rather than
 * an alias of `home_writable` because a custom role may hold one without the
 * other, and false on a system package for the same reason `home_writable` is:
 * the route refuses it before the home is consulted.
 */
export function homeWireForCaller(
  pkg: { type: PackageType; source: string; homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): { home_space_id: string | null; home_writable: boolean; home_shareable: boolean } {
  const reached =
    pkg.homeSpaceId !== null && accessible.some((space) => space.id === pkg.homeSpaceId);
  const system = isSystemPackageRow(pkg);
  return {
    home_space_id: reached ? pkg.homeSpaceId : null,
    home_writable:
      !system && holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, "write")),
    home_shareable:
      !system && holdsHomeAuthority(pkg, accessible, packagePermission(pkg.type, "share")),
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
 * `<type>:<action>` in the home space — the whole rule, with nothing beside it.
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
 */
/**
 * Does the caller hold `permission` in the package's HOME? — the predicate
 * behind every `home_*` answer and every `assertHomeAuthority` verdict.
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
 * By default yes — the behaviour of Notion, Drive and Figma, and what a reader
 * can approximate by hand anyway. An organization that sets
 * `org_settings.restrict_package_copy` narrows the two routes that hand over a
 * whole package — `POST …/fork` and `GET …/{version}/download` — to callers who
 * hold `<type>:share` in the SOURCE's home space (owners and admins when it has
 * none). Without that key, personal spaces open "fork it into mine, then share
 * it on" to every reader, i.e. `share` would protect the link and not the
 * content.
 *
 * SKILLS are exempt in both settings: the CLI's skills sync downloads them into
 * a local checkout by design (`apps/cli/src/lib/skills-sync/plan.ts`), and a
 * skill's audience is already the space it is placed in. RUNS are unaffected
 * — a run's bundle is assembled server-side and never travels as a copy.
 *
 * SYSTEM packages are exempt too, and they are the reason the exemption is
 * stated here rather than left to the home rule: the platform ships them
 * readable in every space of every organization, so there is no "space that
 * owns them" for a setting about copying OUT of one to protect. Exempting them
 * here is what keeps the key from making a refusal about somebody else's
 * content, which this setting never meant to make.
 *
 * The setting is read UNCACHED for the same reason the SSO gate is: a security
 * gate must not answer from a TTL. `c.get("orgSettings")` is the row the
 * session pipeline already loaded; an API key never passes through it.
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
    const orgRole = callerOrgRole(c, orgId);
    const accessible = await packageAccessSpaces(c, orgId, orgRole);
    const source = await assertCatalogPackageAccess(c, packageId, accessible);
    await assertPackageCopyAllowed(c, source, { orgId, accessible });
    return source;
  }
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) {
    throw notFound(`Package '${packageId}' not found`);
  }
  const membership = await getOrgMember(pkg.orgId, c.get("user").id);
  if (!membership) throw notFound(`Package '${packageId}' not found`);
  const accessible = await packageAccessSpaces(c, pkg.orgId, membership.role);
  const source = await assertCatalogPackageAccess(c, packageId, accessible, pkg.orgId);
  await assertPackageCopyAllowed(c, source, { orgId: pkg.orgId, accessible });
  return source;
}

/** Shared authorization for REST and MCP bundle validation/import, before metadata or writes. */
export async function authorizeBundlePackages(c: Context<AppEnv>, bundle: Bundle): Promise<void> {
  const accessible = await packageAccessSpaces(c);
  for (const [identity, pkg] of bundle.packages) {
    const parsed = parsePackageIdentity(identity);
    if (!parsed) throw invalidRequest(`Invalid package identity: ${identity}`);
    const packageId = parsed.packageId;
    if (isSystemPackage(packageId)) {
      const source = await assertCatalogPackageAccess(c, packageId, accessible);
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
      await assertPackageMutationAccess(c, packageId, "write", accessible);
      if (identity === bundle.root)
        await assertExistingPackageActivationAccess(c, packageId, existing.type);
    }
  }
}

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
function manifestPackageRefs(
  manifest: Record<string, unknown>,
): Array<{ id: string; type: PackageType }> {
  const refs = extractDependencies(manifest).map((dependency) => ({
    id: `${dependency.depScope}/${dependency.depName}`,
    type: dependency.depType,
  }));
  const localServer = getLocalServerRef(manifest as unknown as IntegrationManifest);
  if (localServer) refs.push({ id: localServer.name, type: "mcp-server" });
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
  const [accessible, existing] = await Promise.all([
    packageAccessSpaces(c),
    db
      .select({ id: packages.id })
      .from(packages)
      .where(
        inArray(
          packages.id,
          references.map((reference) => reference.id),
        ),
      ),
  ]);
  // Readiness keeps the existing missing-dependency errors; known but inaccessible sources are hidden.
  for (const { id } of existing) await assertCatalogPackageAccess(c, id, accessible);
}
