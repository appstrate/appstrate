// SPDX-License-Identifier: Apache-2.0

/**
 * Application-level package management — install, uninstall, list, and configure
 * packages within an application context.
 */

import { eq, and, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import { notFound, conflict } from "../lib/errors.ts";
import { orgOrSystemFilter } from "../lib/package-helpers.ts";
import type { PackageType } from "@appstrate/core/validation";

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

export async function installPackage(
  applicationId: string,
  orgId: string,
  packageId: string,
  config?: Record<string, unknown>,
) {
  // Verify the package exists in the org catalog (or is a system package)
  const [pkg] = await db
    .select({ id: packages.id, type: packages.type })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId)))
    .limit(1);

  if (!pkg) {
    throw notFound(`Package '${packageId}' not found in organization catalog`);
  }

  // Check not already installed
  const [existing] = await db
    .select({ packageId: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);

  if (existing) {
    throw conflict(
      "already_installed",
      `Package '${packageId}' is already installed in this application`,
    );
  }

  const [row] = await db
    .insert(applicationPackages)
    .values({
      applicationId,
      packageId,
      config: config ?? {},
    })
    .returning();

  return row!;
}

export async function uninstallPackage(applicationId: string, packageId: string): Promise<void> {
  const deleted = await db
    .delete(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .returning({ packageId: applicationPackages.packageId });

  if (deleted.length === 0) {
    throw notFound(`Package '${packageId}' is not installed in this application`);
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

const installedPackageSelect = {
  packageId: applicationPackages.packageId,
  config: applicationPackages.config,
  modelId: applicationPackages.modelId,
  proxyId: applicationPackages.proxyId,
  orgProfileId: applicationPackages.orgProfileId,
  versionId: applicationPackages.versionId,
  enabled: applicationPackages.enabled,
  installedAt: applicationPackages.installedAt,
  updatedAt: applicationPackages.updatedAt,
  packageType: packages.type,
  packageSource: packages.source,
  draftManifest: packages.draftManifest,
};

export async function listInstalledPackages(applicationId: string, type?: PackageType) {
  const conditions = [eq(applicationPackages.applicationId, applicationId)];
  if (type) {
    conditions.push(eq(packages.type, type));
  }

  return db
    .select(installedPackageSelect)
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(and(...conditions));
}

export async function getInstalledPackage(applicationId: string, packageId: string) {
  const [row] = await db
    .select(installedPackageSelect)
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);

  return row ?? null;
}

export async function isPackageInstalled(
  applicationId: string,
  packageId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ packageId: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Check if an application has access to a package.
 *
 * Default application → access to ALL packages in the org (no binding required).
 * Custom application → access only to explicitly installed packages.
 */
export async function hasPackageAccess(
  applicationId: string,
  packageId: string,
  isDefault: boolean,
): Promise<boolean> {
  return isDefault || isPackageInstalled(applicationId, packageId);
}

/**
 * Batch check which packages an application has access to.
 * Returns the set of accessible package IDs.
 *
 * Default application → all packageIds returned.
 * Custom application → only explicitly installed packages.
 */
export async function filterAccessiblePackages(
  applicationId: string,
  packageIds: string[],
  isDefault: boolean,
): Promise<Set<string>> {
  if (packageIds.length === 0) return new Set();
  if (isDefault) return new Set(packageIds);

  // Custom app — single query for all package IDs
  const rows = await db
    .select({ packageId: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        inArray(applicationPackages.packageId, packageIds),
      ),
    );

  return new Set(rows.map((r) => r.packageId));
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function updateInstalledPackage(
  applicationId: string,
  packageId: string,
  updates: {
    config?: Record<string, unknown>;
    modelId?: string | null;
    proxyId?: string | null;
    orgProfileId?: string | null;
    versionId?: number | null;
    enabled?: boolean;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.config !== undefined) set.config = updates.config;
  if (updates.modelId !== undefined) set.modelId = updates.modelId;
  if (updates.proxyId !== undefined) set.proxyId = updates.proxyId;
  if (updates.orgProfileId !== undefined) set.orgProfileId = updates.orgProfileId;
  if (updates.versionId !== undefined) set.versionId = updates.versionId;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;

  const updated = await db
    .update(applicationPackages)
    .set(set)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .returning({ packageId: applicationPackages.packageId });

  if (updated.length === 0) {
    throw notFound(`Package '${packageId}' is not installed in this application`);
  }
}
