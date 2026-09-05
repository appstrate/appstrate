// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, spacePackages, spaces } from "@appstrate/db/schema";
import { extractDependencies } from "@appstrate/core/dependencies";
import { isSystemPackage } from "../services/system-packages.ts";
import { parsePackageIdentity, type Bundle } from "@appstrate/afps-runtime/bundle";
import { makePermissionGuard } from "@appstrate/core/permissions";
import type { OrgRole } from "@appstrate/core/permissions";
import { getOrgMember } from "../services/organizations.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { AppEnv } from "../types/index.ts";
import { effectivePermissions, type Permission } from "./permissions.ts";
import { loadSpaceMemberships, resolveSpaceRole, spacePermissions } from "./space-role.ts";
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

/** Resolve once for catalog listings and cross-space package operations. */
export async function packageAccessSpaces(
  c: Context<AppEnv>,
  orgId = c.get("orgId"),
  orgRole = c.get("orgRole"),
) {
  const [rows, memberships] = await Promise.all([
    db
      .select({
        id: spaces.id,
        name: spaces.name,
        isDefault: spaces.isDefault,
        visibility: spaces.visibility,
        defaultRole: spaces.defaultRole,
      })
      .from(spaces)
      .where(
        and(
          eq(spaces.orgId, orgId),
          c.get("authMethod") === "api_key" || c.get("endUser")
            ? eq(spaces.id, c.get("spaceId"))
            : undefined,
        ),
      ),
    c.get("endUser") && !c.get("orgRole")
      ? Promise.resolve(new Map())
      : loadSpaceMemberships(orgId, c.get("user").id),
  ]);
  const pinned = c.get("authMethod") === "api_key" ? c.get("spaceId") : undefined;
  return rows.flatMap((space) => {
    if (pinned && space.id !== pinned) return [];
    if (c.get("endUser") && !c.get("orgRole")) {
      return space.id === c.get("spaceId")
        ? [{ ...space, permissions: c.get("permissions") ?? new Set<Permission>() }]
        : [];
    }
    const ref = resolveSpaceRole(orgRole, space, memberships.get(space.id) ?? null);
    if (!ref) return [];
    return [
      {
        ...space,
        permissions: effectivePermissions({
          orgPermissions: c.get("orgPermissions") ?? new Set<string>(),
          spacePermissions: spacePermissions(ref),
          scopeCeiling: c.get("scopeCeiling"),
        }),
      },
    ];
  });
}

export function managesOrgCatalog(c: Context<AppEnv>, orgRole: OrgRole = c.get("orgRole")) {
  return c.get("authMethod") !== "api_key" && (orgRole === "owner" || orgRole === "admin");
}

/** Catalog reachability permits copying between accessible spaces, never guessing a private id. */
export async function assertCatalogPackageAccess(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
  source = { orgId: c.get("orgId"), orgRole: c.get("orgRole") },
) {
  const { pkg, accessible, installations } = await loadPackageAccess(
    c,
    packageId,
    resolvedSpaces,
    source.orgId,
  );
  const permitted = accessible.filter((space) =>
    space.permissions.has(packagePermission(pkg.type, "read")),
  );
  const allowed = new Set(permitted.map((space) => space.id));
  if (
    permitted.length === 0 ||
    (pkg.source !== "system" &&
      !installations.some((row) => allowed.has(row.spaceId)) &&
      !(installations.length === 0 && managesOrgCatalog(c, source.orgRole)))
  ) {
    throw notFound(`Package '${packageId}' not found`);
  }
  return pkg;
}

async function loadPackageAccess(
  c: Context<AppEnv>,
  packageId: string,
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
  orgId = c.get("orgId"),
) {
  const [[pkg], accessible, installations] = await Promise.all([
    db
      .select({
        id: packages.id,
        type: packages.type,
        source: packages.source,
        orgId: packages.orgId,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
      .limit(1),
    resolvedSpaces ?? packageAccessSpaces(c),
    db
      .select({ spaceId: spacePackages.spaceId })
      .from(spacePackages)
      .innerJoin(spaces, eq(spaces.id, spacePackages.spaceId))
      .where(and(eq(spacePackages.packageId, packageId), eq(spaces.orgId, orgId))),
  ]);
  if (!pkg) throw notFound(`Package '${packageId}' not found`);
  return { pkg, accessible, installations };
}

/** A package draft/version is shared: authority is required in every affected installation. */
export async function assertPackageMutationAccess(
  c: Context<AppEnv>,
  packageId: string,
  action: "write" | "delete",
  resolvedSpaces?: Awaited<ReturnType<typeof packageAccessSpaces>>,
): Promise<void> {
  const { pkg, accessible, installations } = await loadPackageAccess(c, packageId, resolvedSpaces);
  if (pkg.orgId !== c.get("orgId"))
    throw forbidden("Cannot modify a package not in your organization.");
  const permission = packagePermission(pkg.type, action);
  await makePermissionGuard(permission)(c, async () => {});
  const allowed = new Set(
    accessible.filter((space) => space.permissions.has(permission)).map((space) => space.id),
  );
  if (!managesOrgCatalog(c) && !installations.some((row) => allowed.has(row.spaceId))) {
    throw notFound(`Package '${packageId}' not found`);
  }
  if (installations.some((row) => !allowed.has(row.spaceId))) {
    throw forbidden(
      "Modifying a shared package requires permission in every space where it is installed.",
    );
  }
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
      await assertCatalogPackageAccess(c, packageId, accessible);
      continue;
    }
    const type = pkg.manifest.type;
    if (type !== "agent" && type !== "skill" && type !== "integration" && type !== "mcp-server") {
      throw invalidRequest(`Unknown package type '${String(type)}'`);
    }
    await makePermissionGuard(packagePermission(type, "write"))(c, async () => {});
    const [existing] = await db
      .select({ orgId: packages.orgId })
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);
    if (existing?.orgId === c.get("orgId")) {
      await assertPackageMutationAccess(c, packageId, "write", accessible);
      if (identity === bundle.root) await assertExistingPackageInstallAccess(c, packageId, type);
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
