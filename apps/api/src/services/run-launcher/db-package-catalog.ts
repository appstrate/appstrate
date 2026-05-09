// SPDX-License-Identifier: Apache-2.0

/**
 * {@link DbPackageCatalog} — platform-side implementation of the
 * `PackageCatalog` contract from `@appstrate/afps-runtime/bundle`.
 *
 * Backs onto the existing package schema (`packages`, `package_versions`,
 * `package_dist_tags`) and S3/FS storage (via
 * {@link downloadVersionZip}). Used by:
 *   - `routes/runs.ts` — classic run bundle assembly
 *   - `inline-run.ts` — composed with an in-memory catalog, the posted
 *      payload takes precedence (spec §9.5)
 *   - future export/import endpoints
 *
 * Scope isolation: every instance is bound to a single org; lookups
 * implicitly filter by `orgId`. System packages (`orgId IS NULL`) are
 * visible cross-org.
 */

import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { getErrorMessage } from "@appstrate/core/errors";
import { resolveVersionString } from "@appstrate/core/semver";
import { logger } from "../../lib/logger.ts";
import { packages, packageVersions, packageDistTags } from "@appstrate/db/schema";
import {
  extractRootFromAfps,
  formatPackageIdentity,
  parsePackageIdentity,
  BundleError,
  type BundlePackage,
  type PackageCatalog,
  type PackageIdentity,
  type ResolvedPackage,
} from "@appstrate/afps-runtime/bundle";
import { downloadVersionZip } from "../package-storage.ts";

export interface DbPackageCatalogOptions {
  /** Org whose packages are visible (plus system packages, `orgId IS NULL`). */
  orgId: string;
}

export class DbPackageCatalog implements PackageCatalog {
  /** Cache of resolved versions per `(packageId, versionSpec)`. */
  private readonly resolveCache = new Map<string, ResolvedPackage | null>();

  constructor(private readonly opts: DbPackageCatalogOptions) {}

  async resolve(name: string, versionSpec: string): Promise<ResolvedPackage | null> {
    const key = `${name}\0${versionSpec}`;
    const cached = this.resolveCache.get(key);
    if (cached !== undefined) return cached;

    const [pkgRow] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(eq(packages.id, name), or(eq(packages.orgId, this.opts.orgId), isNull(packages.orgId))),
      )
      .limit(1);

    if (!pkgRow) {
      this.resolveCache.set(key, null);
      return null;
    }

    const [versionRows, tagRows] = await Promise.all([
      db
        .select({
          version: packageVersions.version,
          integrity: packageVersions.integrity,
          yanked: packageVersions.yanked,
        })
        .from(packageVersions)
        .where(eq(packageVersions.packageId, pkgRow.id))
        .orderBy(desc(packageVersions.createdAt)),
      db
        .select({
          tag: packageDistTags.tag,
          version: packageVersions.version,
        })
        .from(packageDistTags)
        .innerJoin(packageVersions, eq(packageDistTags.versionId, packageVersions.id))
        .where(eq(packageDistTags.packageId, pkgRow.id)),
    ]);

    const resolved = pickVersion(versionSpec, versionRows, tagRows);
    if (!resolved) {
      this.resolveCache.set(key, null);
      return null;
    }

    const result: ResolvedPackage = {
      identity: formatPackageIdentity(name as `@${string}/${string}`, resolved.version),
      integrity: resolved.integrity,
    };
    this.resolveCache.set(key, result);
    return result;
  }

  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    const parsed = parsePackageIdentity(identity);
    if (!parsed) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `DbPackageCatalog: invalid identity ${identity}`,
      );
    }

    // Verify the package is in scope for this org.
    const [pkgRow] = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(
          eq(packages.id, parsed.packageId),
          or(eq(packages.orgId, this.opts.orgId), isNull(packages.orgId)),
        ),
      )
      .limit(1);

    if (!pkgRow) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `DbPackageCatalog: ${parsed.packageId} not visible to org ${this.opts.orgId}`,
        { identity, orgId: this.opts.orgId },
      );
    }

    const [versionRow] = await db
      .select({
        integrity: packageVersions.integrity,
        yanked: packageVersions.yanked,
      })
      .from(packageVersions)
      .where(
        and(
          eq(packageVersions.packageId, parsed.packageId),
          eq(packageVersions.version, parsed.version),
        ),
      )
      .limit(1);

    if (!versionRow) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `DbPackageCatalog: version ${identity} not present`,
        { identity },
      );
    }

    // downloadVersionZip enforces the expected integrity (raw ZIP SRI
    // stored in package_versions.integrity) AND runs the signature
    // policy gate. Both live on the storage layer so every run path
    // (classic, inline, scheduled) gets the same checks.
    const zip = await downloadVersionZip(parsed.packageId, parsed.version, versionRow.integrity);
    if (!zip) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `DbPackageCatalog: ${identity} has no ZIP in storage`,
        { identity },
      );
    }

    // Extract the root package (manifest.json + files, RECORD-based
    // integrity) directly. We don't walk the dep graph here — the
    // builder does that by re-entering catalog.resolve/fetch.
    try {
      const bundlePackage = extractRootFromAfps(new Uint8Array(zip));
      if (bundlePackage.identity !== identity) {
        logger.warn("DbPackageCatalog: package id/version mismatch after unzip", {
          expected: identity,
          got: bundlePackage.identity,
        });
      }
      return bundlePackage;
    } catch (err) {
      if (err instanceof BundleError) throw err;
      throw new BundleError(
        "ARCHIVE_INVALID",
        `DbPackageCatalog: failed to extract ${identity}: ${getErrorMessage(err)}`,
        { identity },
      );
    }
  }
}

/**
 * Pick a version from a DB catalog row set using the same 3-step
 * resolution used by other platform endpoints: exact → dist-tag →
 * semver range. Yanked versions are visible only to exact pins.
 *
 * Exported for unit tests.
 */
export function pickVersion(
  versionSpec: string,
  versions: Array<{ version: string; integrity: string; yanked: boolean }>,
  tags: Array<{ tag: string; version: string }>,
): { version: string; integrity: string } | null {
  if (versions.length === 0) return null;

  // Build inputs for the canonical 3-step resolver.
  // Yanked versions are visible only to exact pins → only `exactVersions`
  // includes yanked rows; `rangeVersions` and `distTagMap` exclude them.
  const nonYanked = versions.filter((v) => !v.yanked);
  const exactVersions = versions.map((v) => v.version);
  const rangeVersions = nonYanked.map((v) => v.version);
  const nonYankedSet = new Set(rangeVersions);
  const distTagMap: Record<string, string> = {};
  for (const t of tags) {
    if (nonYankedSet.has(t.version)) distTagMap[t.tag] = t.version;
  }

  const resolvedVersion = resolveVersionString(
    versionSpec,
    exactVersions,
    rangeVersions,
    distTagMap,
  );
  if (resolvedVersion === null) return null;

  const row = versions.find((v) => v.version === resolvedVersion);
  if (!row) return null;
  return { version: row.version, integrity: row.integrity };
}
