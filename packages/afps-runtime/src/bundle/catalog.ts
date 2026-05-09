// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Built-in {@link PackageCatalog} utilities.
 *
 * - {@link emptyPackageCatalog}: resolves nothing. Use for zero-dep roots.
 * - {@link InMemoryPackageCatalog}: holds a pre-supplied map. Dist-tags
 *   can be supplied via the `distTags` option.
 * - {@link composeCatalogs}: fallback chain — first non-null `resolve`
 *   wins; `fetch` routes to the catalog that resolved.
 */

import semver from "semver";
import { BundleError } from "./errors.ts";
import { resolveVersionString } from "./semver-resolve.ts";
import {
  formatPackageIdentity,
  parsePackageIdentity,
  type BundlePackage,
  type PackageCatalog,
  type PackageIdentity,
  type ResolvedPackage,
} from "./types.ts";

/**
 * A catalog that resolves nothing. Useful as the default when a root
 * has no declared dependencies.
 */
export const emptyPackageCatalog: PackageCatalog = {
  async resolve(): Promise<ResolvedPackage | null> {
    return null;
  },
  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    throw new BundleError("DEPENDENCY_UNRESOLVED", `emptyPackageCatalog cannot fetch ${identity}`, {
      identity,
    });
  },
};

export interface InMemoryCatalogOptions {
  /** Optional dist-tag map: `{ "@scope/name": { "latest": "1.2.3" } }`. */
  distTags?: Record<string, Record<string, string>>;
}

/**
 * Catalog backed by an in-memory list of {@link BundlePackage}s.
 *
 * Used for inline runs (the posted payload is loaded into such a
 * catalog and composed in front of the org registry catalog — spec §9.5).
 */
export class InMemoryPackageCatalog implements PackageCatalog {
  /** Index: packageId (`@scope/name`) → sorted list of versions. */
  private readonly versions = new Map<string, string[]>();
  /** Index: full identity → BundlePackage. */
  private readonly byIdentity = new Map<PackageIdentity, BundlePackage>();
  private readonly distTags: Record<string, Record<string, string>>;

  constructor(packages: Iterable<BundlePackage>, opts: InMemoryCatalogOptions = {}) {
    for (const pkg of packages) {
      const parsed = parsePackageIdentity(pkg.identity);
      if (!parsed) {
        throw new BundleError(
          "BUNDLE_JSON_INVALID",
          `InMemoryPackageCatalog: invalid identity ${pkg.identity}`,
        );
      }
      this.byIdentity.set(pkg.identity, pkg);
      const list = this.versions.get(parsed.packageId) ?? [];
      if (!list.includes(parsed.version)) list.push(parsed.version);
      this.versions.set(parsed.packageId, list);
    }
    // Sort desc so semver.maxSatisfying is efficient.
    for (const list of this.versions.values()) {
      list.sort((a, b) => semver.rcompare(a, b));
    }
    this.distTags = opts.distTags ?? {};
  }

  async resolve(name: string, versionSpec: string): Promise<ResolvedPackage | null> {
    const versions = this.versions.get(name);
    if (!versions || versions.length === 0) return null;

    // In-memory catalogs have no yank concept — every known version is
    // visible to all three resolution steps. Pass the same array as
    // both the exact-eligible and range-eligible sets.
    const matched = resolveVersionString(
      versionSpec,
      versions,
      versions,
      this.distTags[name] ?? {},
    );
    if (matched === null) return null;
    return this.toResolved(name, matched);
  }

  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    const pkg = this.byIdentity.get(identity);
    if (!pkg) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `InMemoryPackageCatalog: identity ${identity} not present`,
        { identity },
      );
    }
    return pkg;
  }

  private toResolved(name: string, version: string): ResolvedPackage {
    const identity = formatPackageIdentity(name as `@${string}/${string}`, version);
    const pkg = this.byIdentity.get(identity);
    return { identity, integrity: pkg?.integrity ?? null };
  }
}

/**
 * Composite catalog — tries each underlying catalog in order; first
 * non-null `resolve` wins. `fetch` is routed to the catalog that
 * resolved, via a cache populated during `resolve`. Callers that skip
 * `resolve` and hand `fetch` an opaque identity pay a full sweep (each
 * catalog is queried until one succeeds).
 */
export function composeCatalogs(...catalogs: PackageCatalog[]): PackageCatalog {
  const resolveOwners = new Map<PackageIdentity, PackageCatalog>();

  return {
    async resolve(name, versionSpec) {
      for (const cat of catalogs) {
        const r = await cat.resolve(name, versionSpec);
        if (r) {
          resolveOwners.set(r.identity, cat);
          return r;
        }
      }
      return null;
    },

    async fetch(identity) {
      const owner = resolveOwners.get(identity);
      if (owner) return owner.fetch(identity);
      // Fallback: sweep (cache miss).
      let lastErr: unknown;
      for (const cat of catalogs) {
        try {
          return await cat.fetch(identity);
        } catch (err) {
          lastErr = err;
        }
      }
      throw (
        lastErr ??
        new BundleError(
          "DEPENDENCY_UNRESOLVED",
          `composeCatalogs: no catalog could fetch ${identity}`,
          { identity },
        )
      );
    },
  };
}
