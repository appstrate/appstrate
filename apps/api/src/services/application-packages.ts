// SPDX-License-Identifier: Apache-2.0

/**
 * Application-level package management — install, uninstall, list, and configure
 * packages within an application context.
 */

import { eq, and, or, sql, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages } from "@appstrate/db/schema";
import { notFound, conflict } from "../lib/errors.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "../lib/safe-json.ts";
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
  // Verify the package exists in the org catalog (or is a system package).
  // Ephemeral shadow packages are never installable.
  const [pkg] = await db
    .select({ id: packages.id, type: packages.type })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId), notEphemeralFilter()))
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
  appProfileId: applicationPackages.appProfileId,
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

// ---------------------------------------------------------------------------
// Accessible packages — system packages + explicitly installed (single query)
// ---------------------------------------------------------------------------

/**
 * List all packages accessible to an application, filtered by type.
 * Accessible = system packages (always visible) + explicitly installed in application_packages.
 * Single query via LEFT JOIN — no N+1.
 */
export async function listAccessiblePackages(
  orgId: string,
  applicationId: string,
  type: PackageType,
) {
  return db
    .select({
      id: packages.id,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      // application_packages columns (null for system packages)
      appConfig: applicationPackages.config,
      appModelId: applicationPackages.modelId,
      appProxyId: applicationPackages.proxyId,
      appProfileId: applicationPackages.appProfileId,
      appVersionId: applicationPackages.versionId,
      appEnabled: applicationPackages.enabled,
    })
    .from(packages)
    .leftJoin(
      applicationPackages,
      and(
        eq(applicationPackages.packageId, packages.id),
        eq(applicationPackages.applicationId, applicationId),
      ),
    )
    .where(
      and(
        eq(packages.type, type),
        orgOrSystemFilter(orgId),
        notEphemeralFilter(),
        // system packages always visible, local packages only if installed
        or(eq(packages.source, "system"), isNotNull(applicationPackages.packageId)),
      ),
    )
    .orderBy(sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`);
}

/**
 * Check if an application has access to a specific package.
 * System packages are always accessible; local packages require installation.
 */
export async function hasPackageAccess(applicationId: string, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(
      applicationPackages,
      and(
        eq(applicationPackages.packageId, packages.id),
        eq(applicationPackages.applicationId, applicationId),
      ),
    )
    .where(
      and(
        eq(packages.id, packageId),
        notEphemeralFilter(),
        or(eq(packages.source, "system"), isNotNull(applicationPackages.packageId)),
      ),
    )
    .limit(1);

  return !!row;
}

// ---------------------------------------------------------------------------
// Package Config (per-app) — single source of truth for config/model/proxy/profile
// ---------------------------------------------------------------------------

export async function getPackageConfig(
  applicationId: string,
  packageId: string,
): Promise<{
  config: Record<string, unknown>;
  modelId: string | null;
  proxyId: string | null;
  appProfileId: string | null;
}> {
  const [row] = await db
    .select({
      config: applicationPackages.config,
      modelId: applicationPackages.modelId,
      proxyId: applicationPackages.proxyId,
      appProfileId: applicationPackages.appProfileId,
    })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  return {
    config: asRecord(row?.config),
    modelId: row?.modelId ?? null,
    proxyId: row?.proxyId ?? null,
    appProfileId: row?.appProfileId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Config Updates
// ---------------------------------------------------------------------------

export async function updateInstalledPackage(
  applicationId: string,
  packageId: string,
  updates: {
    config?: Record<string, unknown>;
    modelId?: string | null;
    proxyId?: string | null;
    appProfileId?: string | null;
    versionId?: number | null;
    enabled?: boolean;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.config !== undefined) set.config = updates.config;
  if (updates.modelId !== undefined) set.modelId = updates.modelId;
  if (updates.proxyId !== undefined) set.proxyId = updates.proxyId;
  if (updates.appProfileId !== undefined) set.appProfileId = updates.appProfileId;
  if (updates.versionId !== undefined) set.versionId = updates.versionId;
  if (updates.enabled !== undefined) set.enabled = updates.enabled;

  await db
    .insert(applicationPackages)
    .values({
      applicationId,
      packageId,
      config: updates.config ?? {},
      ...(updates.modelId !== undefined ? { modelId: updates.modelId } : {}),
      ...(updates.proxyId !== undefined ? { proxyId: updates.proxyId } : {}),
      ...(updates.appProfileId !== undefined ? { appProfileId: updates.appProfileId } : {}),
      ...(updates.versionId !== undefined ? { versionId: updates.versionId } : {}),
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [applicationPackages.applicationId, applicationPackages.packageId],
      set,
    });
}
