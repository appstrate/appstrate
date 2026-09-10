// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageShares, spacePackages, spaces } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { isSystemPackage } from "../services/system-packages.ts";
import { parsePackageIdentity, type Bundle } from "@appstrate/afps-runtime/bundle";
import { makePermissionGuard, reportPermissionDenial } from "@appstrate/core/permissions";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { OrgRole } from "@appstrate/core/permissions";
import { getOrgMember, getOrgSettings } from "../services/organizations.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
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

export function spacePackagePermission(
  type: PackageType,
  op: "install" | "configure" | "uninstall",
): Permission {
  if (type === "agent") return "agents:configure";
  if (type === "integration")
    return op === "uninstall" ? "integrations:uninstall" : "integrations:install";
  return packagePermission(type, "write");
}

/** Existing catalog imports must hold the target's install grant before adding an association. */
export async function assertExistingPackageInstallAccess(
  c: Context<AppEnv>,
  packageId: string,
  type: PackageType,
) {
  const target = c.get("space")?.id ?? c.get("spaceId");
  const [installed] = await db
    .select({ packageId: spacePackages.packageId })
    .from(spacePackages)
    .where(and(eq(spacePackages.packageId, packageId), eq(spacePackages.spaceId, target)))
    .limit(1);
  if (!installed)
    await makePermissionGuard(spacePackagePermission(type, "install"))(c, async () => {});
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
 * Org-catalogue authority: a session-borne owner or admin, never an API key.
 *
 * It answers for `home_space_id IS NULL` and for nothing else. A package homed
 * in a space — a PERSONAL space included — is governed by that space's
 * `<type>:write`, so this must never be consulted as a fallback for one: it
 * would hand an admin the drafts in a member's personal space, which is the one
 * thing §3.6 refuses. Both readers (`holdsHomeAuthority`,
 * `assertPackageIsReachable`) therefore test the NULL home first.
 */
export function managesOrgCatalog(c: Context<AppEnv>, orgRole: OrgRole = callerOrgRole(c)) {
  return c.get("authMethod") !== "api_key" && (orgRole === "owner" || orgRole === "admin");
}

/**
 * Does a package's PLACEMENT grant read from these spaces?
 *
 * One rule, one place (RBAC spec §6.9, §6.10): a package is readable where it
 * is INSTALLED, where it is SHARED, and where it is HOMED. The home is a grant
 * of its own — a draft nobody has installed yet is readable where it lives, and
 * an author does not lose sight of their own package because a space uninstalled
 * it. Without the home half, write authority could exceed read access, which is
 * how a builder ended up able to `PUT` a package they could not `GET`. The
 * SHARE half is what makes "Shared with me" a listing at all: an offered package
 * has to be readable (its name, its description, the button that installs it)
 * before the recipient has decided to install it.
 *
 * The readers of this rule differ only in the set they compare against: the
 * org-wide catalog check below, the current-space gate of the package read
 * routes ({@link isPackageReadableInSpace}), the library listing, and the
 * per-type index listing (`listOrgItems`, which expresses it in SQL). Holding
 * `<type>:read` in one of those spaces is the other half of the rule and stays
 * with each reader.
 *
 * READ only. RUNNING a package still requires an INSTALLATION in the space it
 * runs in — `hasPackageAccess`, deliberately untouched, and the reason a share
 * is not an activation: an agent runs with the recipient's credentials, so the
 * recipient installs it themselves.
 *
 * `placedIn` is the disjunction's data half: every space of the caller's
 * organization where the package is installed OR shared. One iterable rather
 * than two arguments because the rule does not distinguish them — a reader that
 * needed to would be reading something other than this rule.
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

/**
 * "Is this package readable from THIS space?" — VISIBILITY, not authorization:
 * the caller's `<type>:read` is a separate guard (the route's `readGuard`, or
 * `requirePackageReadPermission` where the type comes from the row). System
 * packages are readable from every space, and like `hasPackageAccess` this does
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
      installedHere: spacePackages.packageId,
      sharedHere: packageShares.packageId,
    })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, spaceId)),
    )
    .leftJoin(
      packageShares,
      and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, spaceId)),
    )
    .where(and(eq(packages.id, packageId), notEphemeralFilter()))
    .limit(1);
  if (!row) return false;
  if (row.source === "system") return true;
  const here = new Set([spaceId]);
  return placementGrantsRead(row, (row.installedHere ?? row.sharedHere) ? here : [], here);
}

/** Catalog reachability permits copying between accessible spaces, never guessing a private id. */
export async function assertCatalogPackageAccess(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
  source = { orgId: c.get("orgId"), orgRole: callerOrgRole(c, c.get("orgId")) },
) {
  const [pkg, accessible, placements] = await Promise.all([
    loadPackageRow(packageId, source.orgId),
    resolvedSpaces ?? packageAccessSpaces(c),
    loadPackagePlacements(packageId, source.orgId),
  ]);
  assertPackageIsReachable(c, packageId, pkg, placements, accessible, source.orgRole);
  return pkg;
}

type PackageAccessRow = Awaited<ReturnType<typeof loadPackageRow>>;

/** The five columns every access decision reads. 404 when the org cannot see the id at all. */
async function loadPackageRow(packageId: string, orgId: string) {
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
  if (!pkg) throw notFound(`Package '${packageId}' not found`);
  return pkg;
}

/**
 * Every space of `orgId` the package is PLACED in — installed and shared, the
 * two halves KEPT APART. {@link placementGrantsRead} does not distinguish them
 * and receives their union; the org-catalogue exception in
 * {@link assertPackageIsReachable} reads the INSTALLED half alone, and merging
 * them here is what made a single share cancel that exception (see there).
 *
 * Split out from the row read because the write path never needs either half:
 * authority is the home alone, so the placements are loaded only when a refusal
 * has to decide between 403 and 404.
 */
async function loadPackagePlacements(
  packageId: string,
  orgId: string,
): Promise<{ installed: string[]; shared: string[] }> {
  const [installed, shared] = await Promise.all([
    db
      .select({ spaceId: spacePackages.spaceId })
      .from(spacePackages)
      .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
      .where(and(eq(spacePackages.packageId, packageId), eq(spaces.orgId, orgId))),
    db
      .select({ spaceId: packageShares.spaceId })
      .from(packageShares)
      .innerJoin(spaces, eq(spaces.id, packageShares.spaceId))
      .where(and(eq(packageShares.packageId, packageId), eq(spaces.orgId, orgId))),
  ]);
  return {
    installed: installed.map((row) => row.spaceId),
    shared: shared.map((row) => row.spaceId),
  };
}

/** 404 unless the caller may know this id exists — {@link placementGrantsRead} + `<type>:read`. */
function assertPackageIsReachable(
  c: Context<AppEnv>,
  packageId: string,
  pkg: PackageAccessRow,
  placements: { installed: string[]; shared: string[] },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
  orgRole: OrgRole,
): void {
  const opens = packageReadPermissions(pkg.type);
  const permitted = accessible.filter((space) =>
    opens.some((permission) => space.permissions.has(permission)),
  );
  const readable = new Set(permitted.map((space) => space.id));
  if (
    permitted.length === 0 ||
    (pkg.source !== "system" &&
      !placementGrantsRead(pkg, [...placements.installed, ...placements.shared], readable) &&
      // The org-catalogue exception is for a package with NO home. One homed in
      // a space is reachable through that space or not at all — otherwise an
      // admin would read a draft that lives, uninstalled, in a member's
      // personal space (§3.6).
      //
      // "Placed nowhere" here means INSTALLED nowhere, and the share half is
      // deliberately not consulted: a NULL-home package is the organization's,
      // and offering it to somebody must not take it away from the catalogue
      // it belongs to. Reading the union instead made one share turn the
      // owner's own package into a 404 on its versions, its fork and its
      // installation. `GET /api/library` states the same rule as
      // `!row.installedAnywhere` — one rule, two readers, the same reading.
      !(
        pkg.homeSpaceId === null &&
        placements.installed.length === 0 &&
        managesOrgCatalog(c, orgRole)
      ))
  ) {
    throw notFound(`Package '${packageId}' not found`);
  }
}

/**
 * Write authority is the package's HOME (`packages.home_space_id`) and nothing
 * else — not the space the caller happens to be in, not the set of spaces it is
 * installed in: those consume the package and have no say over its draft,
 * versions or identity. A NULL home is the organization catalogue — owners and
 * admins in session, which is what {@link managesOrgCatalog} means.
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
 * Authority to change a package's AUDIENCE — `<type>:share` in its home space
 * (RBAC spec §6.10). The same rule, the same reader and the same 404/403 split
 * as a mutation: the home decides, an unreachable id stays a 404, and a NULL
 * home is the organization catalogue.
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
  if (holdsHomeAuthority(c, pkg, accessible, permission)) return pkg;
  // Refused. Whether the caller may even KNOW this id exists is the read
  // question, answered by the one predicate that answers it — an unreachable
  // package stays a 404 rather than becoming an existence oracle. Only this
  // path pays for the placements.
  assertPackageIsReachable(
    c,
    packageId,
    pkg,
    await loadPackagePlacements(packageId, orgId),
    accessible,
    callerOrgRole(c, orgId),
  );
  reportPermissionDenial(c, permission);
  const verb = action === "share" ? "Sharing" : "Modifying";
  throw forbidden(
    pkg.homeSpaceId === null
      ? `${verb} '${packageId}' requires organization owner or admin authority — it belongs to the organization catalog.`
      : `${verb} '${packageId}' requires '${permission}' in its home space.`,
  );
}

/**
 * The two `home_*` fields EVERY package read emits — one contract, computed
 * once, for `AgentDetail`, `OrgPackageItem`, `OrgPackageItemDetail` and the
 * library listing.
 *
 * `home_space_id` is the home's id **only when the caller reaches that space**,
 * and `null` otherwise. The raw column cannot go on the wire: a package homed in
 * a member's PERSONAL space is legitimately readable by everyone it is
 * installed for, and emitting its home would hand each of them the id of a
 * space §3.6 says does not exist for them. `null` therefore means "not a space
 * you can see" — the organization catalogue and a withheld home both — and
 * nothing downstream needs to tell those apart: what a reader actually wants to
 * know is whether they may WRITE, which is the second field.
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
  c: Context<AppEnv>,
  pkg: { type: PackageType; source: string; homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): { home_space_id: string | null; home_writable: boolean; home_shareable: boolean } {
  const reached =
    pkg.homeSpaceId !== null && accessible.some((space) => space.id === pkg.homeSpaceId);
  const system = isSystemPackageRow(pkg);
  return {
    home_space_id: reached ? pkg.homeSpaceId : null,
    home_writable:
      !system && holdsHomeAuthority(c, pkg, accessible, packagePermission(pkg.type, "write")),
    home_shareable:
      !system && holdsHomeAuthority(c, pkg, accessible, packagePermission(pkg.type, "share")),
  };
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
 * `<type>:<action>` in the home space, or org-catalog authority when it has
 * none. `orgRole` is the caller's standing in the organization that OWNS the
 * package, which is the caller's own org everywhere except the cross-org fork
 * reader — there it is their membership role in the source org.
 */
function holdsHomeAuthority(
  c: Context<AppEnv>,
  pkg: { homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
  permission: Permission,
  orgRole: OrgRole = callerOrgRole(c),
): boolean {
  if (pkg.homeSpaceId === null) return managesOrgCatalog(c, orgRole);
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
 * skill's audience is already the space it is installed in. RUNS are unaffected
 * — a run's bundle is assembled server-side and never travels as a copy.
 *
 * SYSTEM packages are exempt too, and they are the reason the exemption is
 * stated here rather than left to the home rule: the platform ships them
 * readable in every space of every organization, so there is no "space that
 * owns them" for a setting about copying OUT of one to protect. Their home is
 * `NULL`, which the home rule reads as the organization catalogue — that turned
 * the key into "only owners and admins may install the shipped catalogue", a
 * refusal about somebody else's content that this setting never meant to make.
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
    orgRole: OrgRole;
    accessible: Awaited<ReturnType<typeof packageAccessSpaces>>;
  },
): Promise<void> {
  if (pkg.type === "skill" || isSystemPackageRow(pkg)) return;
  // The SOURCE organization's setting and the caller's standing THERE — a fork
  // may cross organizations, and it is the source's content being protected.
  const settings =
    source.orgId === c.get("orgId")
      ? (c.get("orgSettings") ?? (await getOrgSettings(source.orgId)))
      : await getOrgSettings(source.orgId);
  if (settings.restrict_package_copy !== true) return;
  const permission = packagePermission(pkg.type, "share");
  if (holdsHomeAuthority(c, pkg, source.accessible, permission, source.orgRole)) return;
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
    await assertPackageCopyAllowed(c, source, { orgId, orgRole, accessible });
    return source;
  }
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) {
    throw notFound(`Package '${packageId}' not found`);
  }
  const membership = await getOrgMember(pkg.orgId, c.get("user").id);
  if (!membership) throw notFound(`Package '${packageId}' not found`);
  const accessible = await packageAccessSpaces(c, pkg.orgId, membership.role);
  const source = await assertCatalogPackageAccess(c, packageId, accessible, {
    orgId: pkg.orgId,
    orgRole: membership.role,
  });
  await assertPackageCopyAllowed(c, source, {
    orgId: pkg.orgId,
    orgRole: membership.role,
    accessible,
  });
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
        await assertExistingPackageInstallAccess(c, packageId, source.type);
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
        await assertExistingPackageInstallAccess(c, packageId, existing.type);
    }
  }
}

/** Caller-authored references need live source read access; unchanged references need no new scope. */
export async function assertPackageDependenciesAccessible(
  c: Context<AppEnv>,
  manifest: Record<string, unknown>,
  previous: Record<string, unknown> = {},
): Promise<void> {
  const previousIds = new Set(
    extractDependencies(previous).map(
      (dependency) => `${dependency.depScope}/${dependency.depName}`,
    ),
  );
  const dependencies = extractDependencies(manifest).filter(
    (dependency) => !previousIds.has(`${dependency.depScope}/${dependency.depName}`),
  );
  if (!dependencies.length) return;
  const checked = new Set<string>();
  for (const dependency of dependencies) {
    if (checked.has(dependency.depType)) continue;
    checked.add(dependency.depType);
    await makePermissionGuard(packagePermission(dependency.depType, "read"))(c, async () => {});
  }
  const [accessible, existing] = await Promise.all([
    packageAccessSpaces(c),
    db
      .select({ id: packages.id })
      .from(packages)
      .where(
        inArray(
          packages.id,
          dependencies.map((dependency) => `${dependency.depScope}/${dependency.depName}`),
        ),
      ),
  ]);
  // Readiness keeps the existing missing-dependency errors; known but inaccessible sources are hidden.
  for (const { id } of existing) await assertCatalogPackageAccess(c, id, accessible);
}
