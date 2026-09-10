// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, spacePackages, spaces } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { isSystemPackage } from "../services/system-packages.ts";
import { parsePackageIdentity, type Bundle } from "@appstrate/afps-runtime/bundle";
import { makePermissionGuard, reportPermissionDenial } from "@appstrate/core/permissions";
import { requireAnyPermission } from "../middleware/require-permission.ts";
import type { OrgRole } from "@appstrate/core/permissions";
import { getOrgMember } from "../services/organizations.ts";
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
import { forbidden, notFound, invalidRequest } from "./errors.ts";

const PACKAGE_RESOURCES = {
  agent: "agents",
  skill: "skills",
  integration: "integrations",
  "mcp-server": "mcp-servers",
} as const;

export function packagePermission(
  type: PackageType,
  action: "read" | "write" | "delete",
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
 * One rule, one place (RBAC spec §6.9): a package is readable where it is
 * INSTALLED and where it is HOMED. The home is a grant of its own — a draft
 * nobody has installed yet is readable where it lives, and an author does not
 * lose sight of their own package because a space uninstalled it. Without the
 * home half, write authority could exceed read access, which is how a builder
 * ended up able to `PUT` a package they could not `GET`.
 *
 * The readers of this rule differ only in the set they compare against: the
 * org-wide catalog check below, the current-space gate of the package read
 * routes ({@link isPackageReadableInSpace}), the library listing, and the
 * per-type index listing (`listOrgItems`, which expresses it in SQL). Holding
 * `<type>:read` in one of those spaces is the other half of the rule and stays
 * with each reader.
 *
 * READ only. RUNNING a package still requires an installation in the space it
 * runs in — `hasPackageAccess`, deliberately untouched.
 */
export function placementGrantsRead(
  pkg: { homeSpaceId: string | null },
  installedIn: Iterable<string>,
  readable: ReadonlySet<string>,
): boolean {
  if (pkg.homeSpaceId !== null && readable.has(pkg.homeSpaceId)) return true;
  for (const spaceId of installedIn) if (readable.has(spaceId)) return true;
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
    })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, spaceId)),
    )
    .where(and(eq(packages.id, packageId), notEphemeralFilter()))
    .limit(1);
  if (!row) return false;
  if (row.source === "system") return true;
  const here = new Set([spaceId]);
  return placementGrantsRead(row, row.installedHere ? here : [], here);
}

/** Catalog reachability permits copying between accessible spaces, never guessing a private id. */
export async function assertCatalogPackageAccess(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
  source = { orgId: c.get("orgId"), orgRole: callerOrgRole(c, c.get("orgId")) },
) {
  const [pkg, accessible, installations] = await Promise.all([
    loadPackageRow(packageId, source.orgId),
    resolvedSpaces ?? packageAccessSpaces(c),
    loadPackageInstallations(packageId, source.orgId),
  ]);
  assertPackageIsReachable(c, packageId, pkg, installations, accessible, source.orgRole);
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
 * Every space of `orgId` the package is installed in. Split out from the row
 * read because the write path never needs it: authority is the home alone, so
 * the installations are loaded only when a refusal has to decide between 403
 * and 404.
 */
function loadPackageInstallations(packageId: string, orgId: string) {
  return db
    .select({ spaceId: spacePackages.spaceId })
    .from(spacePackages)
    .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
    .where(and(eq(spacePackages.packageId, packageId), eq(spaces.orgId, orgId)));
}

/** 404 unless the caller may know this id exists — {@link placementGrantsRead} + `<type>:read`. */
function assertPackageIsReachable(
  c: Context<AppEnv>,
  packageId: string,
  pkg: PackageAccessRow,
  installations: { spaceId: string }[],
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
      !placementGrantsRead(
        pkg,
        installations.map((row) => row.spaceId),
        readable,
      ) &&
      // The org-catalogue exception is for a package with NO home. One homed in
      // a space is reachable through that space or not at all — otherwise an
      // admin would read a draft that lives, uninstalled, in a member's
      // personal space (§3.6).
      !(pkg.homeSpaceId === null && installations.length === 0 && managesOrgCatalog(c, orgRole)))
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
    throw forbidden("Cannot modify a system package.");
  }
  const permission = packagePermission(pkg.type, action);
  if (holdsHomeAuthority(c, pkg, accessible, permission)) return pkg;
  // Refused. Whether the caller may even KNOW this id exists is the read
  // question, answered by the one predicate that answers it — an unreachable
  // package stays a 404 rather than becoming an existence oracle. Only this
  // path pays for the installations.
  assertPackageIsReachable(
    c,
    packageId,
    pkg,
    await loadPackageInstallations(packageId, orgId),
    accessible,
    callerOrgRole(c, orgId),
  );
  reportPermissionDenial(c, permission);
  throw forbidden(
    pkg.homeSpaceId === null
      ? `Modifying '${packageId}' requires organization owner or admin authority — it belongs to the organization catalog.`
      : `Modifying '${packageId}' requires '${permission}' in its home space.`,
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
 */
export function homeWireForCaller(
  c: Context<AppEnv>,
  pkg: { type: PackageType; source: string; homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
): { home_space_id: string | null; home_writable: boolean } {
  const reached =
    pkg.homeSpaceId !== null && accessible.some((space) => space.id === pkg.homeSpaceId);
  return {
    home_space_id: reached ? pkg.homeSpaceId : null,
    home_writable:
      !isSystemPackageRow(pkg) &&
      holdsHomeAuthority(c, pkg, accessible, packagePermission(pkg.type, "write")),
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

/** `<type>:<action>` in the home space, or org-catalog authority when it has none. */
function holdsHomeAuthority(
  c: Context<AppEnv>,
  pkg: { homeSpaceId: string | null },
  accessible: Awaited<ReturnType<typeof packageAccessSpaces>>,
  permission: Permission,
): boolean {
  if (pkg.homeSpaceId === null) return managesOrgCatalog(c);
  const home = accessible.find((space) => space.id === pkg.homeSpaceId);
  return home?.permissions.has(permission) ?? false;
}

/** Forking reads source bytes, including when the destination is another organization. */
export async function assertForkSourceAccess(c: Context<AppEnv>, packageId: string) {
  const [pkg] = await db
    .select({ orgId: packages.orgId })
    .from(packages)
    .where(and(eq(packages.id, packageId), notEphemeralFilter()))
    .limit(1);
  if (!pkg) throw notFound(`Package '${packageId}' not found`);
  if (!pkg.orgId || pkg.orgId === c.get("orgId")) return assertCatalogPackageAccess(c, packageId);
  if (c.get("authMethod") !== "session" && !c.get("deferOrgResolution")) {
    throw notFound(`Package '${packageId}' not found`);
  }
  const membership = await getOrgMember(pkg.orgId, c.get("user").id);
  if (!membership) throw notFound(`Package '${packageId}' not found`);
  const accessible = await packageAccessSpaces(c, pkg.orgId, membership.role);
  return assertCatalogPackageAccess(c, packageId, accessible, {
    orgId: pkg.orgId,
    orgRole: membership.role,
  });
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
