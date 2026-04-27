// SPDX-License-Identifier: Apache-2.0

/**
 * Application-level package management — install, uninstall, list, and configure
 * packages within an application context.
 */

import { eq, and, or, sql, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { applicationPackages, packages, applications, packageVersions } from "@appstrate/db/schema";
import { notFound, conflict } from "../lib/errors.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import { parseDraftManifest, extractDepsFromManifest } from "../lib/manifest-utils.ts";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { AppScope } from "../lib/scope.ts";

export type { ResolvedRunConfig };

// ---------------------------------------------------------------------------
// Internal helper — verify the scope's application belongs to the scope's org.
// Used by install which mutates installation state.
// ---------------------------------------------------------------------------

async function assertAppBelongsToOrg(scope: AppScope): Promise<void> {
  const [app] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.id, scope.applicationId), eq(applications.orgId, scope.orgId)))
    .limit(1);
  if (!app) {
    throw notFound(`Application '${scope.applicationId}' not found in this organization`);
  }
}

// ---------------------------------------------------------------------------
// Install / Uninstall
// ---------------------------------------------------------------------------

export async function installPackage(
  scope: AppScope,
  packageId: string,
  config?: Record<string, unknown>,
) {
  await assertAppBelongsToOrg(scope);

  // Verify the package exists in the org catalog (or is a system package).
  // Ephemeral shadow packages are never installable.
  const [pkg] = await db
    .select({ id: packages.id, type: packages.type })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
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
        eq(applicationPackages.applicationId, scope.applicationId),
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
      applicationId: scope.applicationId,
      packageId,
      config: config ?? {},
    })
    .returning();

  return row!;
}

export async function uninstallPackage(scope: AppScope, packageId: string): Promise<void> {
  const deleted = await db
    .delete(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
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

export async function listInstalledPackages(scope: AppScope, type?: PackageType) {
  const conditions = [eq(applicationPackages.applicationId, scope.applicationId)];
  if (type) {
    conditions.push(eq(packages.type, type));
  }

  return db
    .select(installedPackageSelect)
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(and(...conditions));
}

export async function getInstalledPackage(scope: AppScope, packageId: string) {
  const [row] = await db
    .select(installedPackageSelect)
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
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
export async function listAccessiblePackages(scope: AppScope, type: PackageType) {
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
        eq(applicationPackages.applicationId, scope.applicationId),
      ),
    )
    .where(
      and(
        eq(packages.type, type),
        orgOrSystemFilter(scope.orgId),
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
export async function hasPackageAccess(scope: AppScope, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(
      applicationPackages,
      and(
        eq(applicationPackages.packageId, packages.id),
        eq(applicationPackages.applicationId, scope.applicationId),
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

// ---------------------------------------------------------------------------
// Resolved run-config — single source of truth for both the UI's per-app
// agent run and the CLI's `appstrate run @scope/agent` invocation. The
// CLI reads this endpoint after profile resolution to reproduce the UI
// run byte-for-byte (same model, proxy, config, version pin) unless the
// user passed an explicit override flag.
//
// Wire shape lives in `@appstrate/shared-types` so the CLI consumes the
// same interface without redeclaring it.
// ---------------------------------------------------------------------------

/**
 * Resolve the per-application run configuration for `(applicationId,
 * packageId)`. Returns `null` when no `application_packages` row exists
 * for the pair — the caller (route or CLI) decides whether that is a
 * 404 or a "no inheritance, fall back to flags + defaults" signal.
 *
 * Provider ids are read from the package's draft manifest (the same
 * source `requireAgent()` + `resolveManifestProviders` uses for
 * runtime), keeping the CLI preflight aligned with the actual run
 * pipeline without duplicating the manifest-walk code.
 */
export async function getResolvedRunConfig(
  applicationId: string,
  packageId: string,
): Promise<ResolvedRunConfig | null> {
  const [row] = await db
    .select({
      config: applicationPackages.config,
      modelId: applicationPackages.modelId,
      proxyId: applicationPackages.proxyId,
      versionId: applicationPackages.versionId,
      draftManifest: packages.draftManifest,
    })
    .from(applicationPackages)
    .innerJoin(packages, eq(packages.id, applicationPackages.packageId))
    .where(
      and(
        eq(applicationPackages.applicationId, applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);

  if (!row) return null;

  let versionPin: string | null = null;
  if (row.versionId !== null && row.versionId !== undefined) {
    const [versionRow] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, row.versionId))
      .limit(1);
    versionPin = versionRow?.version ?? null;
  }

  const manifest = parseDraftManifest(row.draftManifest);
  const { providerIds } = extractDepsFromManifest(manifest);

  return {
    config: asRecord(row.config),
    modelId: row.modelId ?? null,
    proxyId: row.proxyId ?? null,
    versionPin,
    requiredProviders: providerIds,
  };
}

export async function updateInstalledPackage(
  scope: AppScope,
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
      applicationId: scope.applicationId,
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
