// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-side bundle assembly helpers.
 *
 * These are thin wrappers over the runtime primitives — the only
 * platform-specific concern is plumbing {@link DbPackageCatalog} +
 * {@link InMemoryPackageCatalog} through the right composition for each
 * entry point (classic run, inline run, future export endpoint).
 *
 * Runtime primitives are in `@appstrate/afps-runtime/bundle`:
 *   - `buildBundleFromCatalog` — transitive walk
 *   - `buildBundleFromAfps` — raw .afps → Bundle (import path)
 *   - `writeBundleToBuffer` — deterministic `.afps-bundle` serialization
 */

import {
  buildBundleFromAfps,
  buildBundleFromCatalog,
  composeCatalogs,
  extractRootFromAfps,
  InMemoryPackageCatalog,
  type Bundle,
  type BundleMetadata,
  type BundlePackage,
  type PackageCatalog,
} from "@appstrate/afps-runtime/bundle";
import { DbPackageCatalog } from "./adapters/db-package-catalog.ts";
import { downloadVersionZip } from "./package-storage.ts";
import { resolveVersion } from "./package-versions.ts";
import { db } from "@appstrate/db/client";
import { packageVersions, applicationPackages } from "@appstrate/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "../lib/errors.ts";

export interface BundleAssemblyScope {
  orgId: string;
  applicationId: string;
}

/**
 * Build a Bundle for a classic run — the root agent was resolved from
 * the DB and its transitive deps come from the org registry.
 */
export async function buildBundleFromDb(
  root: BundlePackage,
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const catalog = new DbPackageCatalog({ orgId: scope.orgId });
  return buildBundleFromCatalog(root, catalog, { metadata });
}

/**
 * Build a Bundle for an inline run — the root + any declared companion
 * packages come from the posted payload; unresolved transitive deps
 * fall through to the org registry (spec §9.5).
 */
export async function buildBundleFromInlinePayload(
  root: BundlePackage,
  inlinePackages: BundlePackage[],
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const inline = new InMemoryPackageCatalog(inlinePackages);
  const db = new DbPackageCatalog({ orgId: scope.orgId });
  const composed: PackageCatalog = composeCatalogs(inline, db);
  return buildBundleFromCatalog(root, composed, { metadata });
}

/**
 * Build a Bundle from a raw .afps archive (import path). Applies the
 * same conversion semantics as every other ingestion boundary — one
 * bug-fix surface for manifest parsing, archive sanitization, and
 * integrity computation.
 */
export async function buildBundleFromUploadedAfps(
  archive: Uint8Array,
  scope: BundleAssemblyScope,
  metadata?: BundleMetadata,
): Promise<Bundle> {
  const catalog = new DbPackageCatalog({ orgId: scope.orgId });
  return buildBundleFromAfps(archive, catalog, { metadata });
}

// ---------------------------------------------------------------------------
// Export path — build a Bundle for GET /api/agents/:scope/:name/bundle
// ---------------------------------------------------------------------------

/**
 * Resolve the version of a package that should be exported.
 *
 * Resolution order:
 *   1. Explicit `versionQuery` (exact / dist-tag / semver range) — fails
 *      with 404 if unresolvable.
 *   2. The version currently installed in the app (`application_packages.version_id`).
 *   3. The `"latest"` dist-tag of the package.
 *
 * Returns the resolved `version` string. Throws `notFound` if no version
 * exists for the package.
 */
export async function resolveExportVersion(
  packageId: string,
  scope: BundleAssemblyScope,
  versionQuery?: string | null,
): Promise<string> {
  if (versionQuery) {
    const versionId = await resolveVersion(packageId, versionQuery);
    if (!versionId) {
      throw notFound(`Version '${versionQuery}' not found for '${packageId}'`);
    }
    const [row] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, versionId))
      .limit(1);
    if (!row) throw notFound(`Version '${versionQuery}' not found for '${packageId}'`);
    return row.version;
  }

  // Installed version pin
  const [installed] = await db
    .select({ version: packageVersions.version })
    .from(applicationPackages)
    .innerJoin(packageVersions, eq(packageVersions.id, applicationPackages.versionId))
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, packageId),
      ),
    )
    .limit(1);
  if (installed) return installed.version;

  // Fall back to "latest"
  const latestId = await resolveVersion(packageId, "latest");
  if (latestId) {
    const [row] = await db
      .select({ version: packageVersions.version })
      .from(packageVersions)
      .where(eq(packageVersions.id, latestId))
      .limit(1);
    if (row) return row.version;
  }

  throw notFound(
    `No exportable version found for '${packageId}' — publish a version first, then retry`,
  );
}

/**
 * Build an export Bundle for the given package at the resolved version.
 *
 * Downloads the AFPS ZIP for `(packageId, version)` from storage, runs it
 * through the same extraction primitive as ingestion (`extractRootFromAfps`),
 * and walks transitive dependencies via {@link DbPackageCatalog}. The result
 * is a canonical multi-package Bundle that can be serialised to bytes via
 * {@link writeBundleToBuffer} and streamed to the caller.
 */
export async function buildBundleForAgentExport(
  packageId: string,
  scope: BundleAssemblyScope,
  opts: { versionQuery?: string | null; metadata?: BundleMetadata } = {},
): Promise<Bundle> {
  const version = await resolveExportVersion(packageId, scope, opts.versionQuery);
  const zip = await downloadVersionZip(packageId, version);
  if (!zip) {
    throw notFound(`Artifact missing for '${packageId}@${version}'`);
  }
  const root = extractRootFromAfps(new Uint8Array(zip));
  return buildBundleFromDb(root, scope, opts.metadata);
}
