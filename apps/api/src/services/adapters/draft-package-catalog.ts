// SPDX-License-Identifier: Apache-2.0

/**
 * {@link DraftPackageCatalog} — platform-side `PackageCatalog` that
 * resolves dependencies against the DRAFT state of each package (the
 * `packages.draftManifest` column + the `package-items` storage
 * bucket) rather than against published versions.
 *
 * This is the catalog used on the run hot path by `buildAgentPackage`,
 * where runs must see the latest tool/skill/provider edits without a
 * republish step. The counterpart {@link DbPackageCatalog} resolves
 * against published versions (signed, version-range-pinned) and is
 * used by the import/export endpoints, where reproducibility matters
 * more than edit-loop responsiveness.
 *
 * Contract details:
 *   - `resolve(name, versionSpec)` ignores `versionSpec` — draft deps
 *     are referenced by id only, and the identity is synthesised from
 *     the dep's own `draftManifest.version` so the produced Bundle is
 *     still identity-keyed and walk-cycle-safe.
 *   - `fetch(identity)` returns a `BundlePackage` whose `integrity` is
 *     left empty; `buildBundleFromCatalog` recomputes it from the
 *     RECORD entries (same policy as `DbPackageCatalog`).
 *   - System packages (`orgId IS NULL`) are visible cross-org — same
 *     rule as every other platform resolver.
 */

import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages } from "@appstrate/db/schema";
import {
  BundleError,
  formatPackageIdentity,
  parsePackageIdentity,
  type BundlePackage,
  type PackageCatalog,
  type PackageIdentity,
  type ResolvedPackage,
} from "@appstrate/afps-runtime/bundle";
import { asRecord } from "../../lib/safe-json.ts";
import { downloadPackageFiles } from "../package-items/storage.ts";

export interface DraftPackageCatalogOptions {
  /** Org whose draft packages are visible (plus system packages, `orgId IS NULL`). */
  orgId: string;
}

type DraftStorageFolder = "skills" | "tools" | "providers";

export class DraftPackageCatalog implements PackageCatalog {
  private readonly rowCache = new Map<
    string,
    { draftManifest: unknown } | null | Promise<{ draftManifest: unknown } | null>
  >();
  private readonly fetchCache = new Map<PackageIdentity, BundlePackage>();

  constructor(private readonly opts: DraftPackageCatalogOptions) {}

  async resolve(name: string, _versionSpec: string): Promise<ResolvedPackage | null> {
    const row = await this.getPackageRow(name);
    if (!row) return null;
    const manifest = asRecord(row.draftManifest);
    const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
    return {
      identity: formatPackageIdentity(name as `@${string}/${string}`, version),
      integrity: "",
    };
  }

  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    const cached = this.fetchCache.get(identity);
    if (cached) return cached;

    const parsed = parsePackageIdentity(identity);
    if (!parsed) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `DraftPackageCatalog: invalid identity ${identity}`,
      );
    }

    const row = await this.getPackageRow(parsed.packageId);
    if (!row) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `DraftPackageCatalog: ${parsed.packageId} not visible to org ${this.opts.orgId}`,
        { identity, orgId: this.opts.orgId },
      );
    }

    const manifest = asRecord(row.draftManifest);
    const folder = typeToFolder(manifest.type);
    if (!folder) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `DraftPackageCatalog: ${parsed.packageId} has unsupported type ${String(manifest.type)}`,
        { identity },
      );
    }

    const files = await downloadPackageFiles(folder, this.opts.orgId, parsed.packageId);
    if (!files) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `DraftPackageCatalog: ${parsed.packageId} has no files in storage`,
        { identity },
      );
    }

    // Ensure manifest.json is present (some upload paths store only content
    // files). Reconstruct from draftManifest to keep the Bundle self-contained.
    const fileMap = new Map<string, Uint8Array>();
    for (const [p, bytes] of Object.entries(files)) fileMap.set(p, bytes);
    if (!fileMap.has("manifest.json")) {
      fileMap.set(
        "manifest.json",
        new TextEncoder().encode(JSON.stringify(row.draftManifest, null, 2)),
      );
    }

    const pkg: BundlePackage = {
      identity,
      manifest: asRecord(row.draftManifest),
      files: fileMap,
      integrity: "",
    };
    this.fetchCache.set(identity, pkg);
    return pkg;
  }

  private getPackageRow(packageId: string): Promise<{ draftManifest: unknown } | null> {
    const cached = this.rowCache.get(packageId);
    if (cached !== undefined) return Promise.resolve(cached);

    const promise = db
      .select({ draftManifest: packages.draftManifest })
      .from(packages)
      .where(
        and(
          eq(packages.id, packageId),
          or(eq(packages.orgId, this.opts.orgId), isNull(packages.orgId)),
        ),
      )
      .limit(1)
      .then((rows) => {
        const row = rows[0] ?? null;
        this.rowCache.set(packageId, row);
        return row;
      });
    this.rowCache.set(packageId, promise);
    return promise;
  }
}

function typeToFolder(type: unknown): DraftStorageFolder | null {
  if (type === "skill") return "skills";
  if (type === "tool") return "tools";
  if (type === "provider") return "providers";
  return null;
}
