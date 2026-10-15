// SPDX-License-Identifier: Apache-2.0

/**
 * {@link DraftPackageCatalog} — platform-side `PackageCatalog` that
 * resolves dependencies against the DRAFT state of each package (the
 * `packages.draftManifest` column + the `package-items` storage
 * bucket) rather than against published versions.
 *
 * It has ONE caller: {@link RunPackageCatalog}, and only for a dependency
 * a run explicitly overrode with `"draft"` — the edit loop (edit SKILL.md or
 * INTEGRATION.md → run → observe, no republish per iteration). For an
 * integration the override arrives as the run's frozen `draft` source. It
 * is an act of authorship and carries its own gate
 * (`assertDependencyDraftOverridesAllowed`, RBAC spec §6.10), so every path
 * through this class has already proven write authority over the package whose
 * working copy it is about to read.
 *
 * Nothing else resolves against drafts. A run with no override, and the bundle
 * EXPORT of a draft agent (`?source=draft`), both walk the closure with
 * {@link DbPackageCatalog} against published versions, which
 * keeps the exported archive byte-identical to what the server would execute.
 *
 * Contract details:
 *   - `resolve(name, versionSpec)` ignores `versionSpec` — draft deps
 *     are referenced by id only, and the identity is synthesised from
 *     the dep's own `draftManifest.version` so the produced Bundle is
 *     still identity-keyed and walk-cycle-safe.
 *   - `fetch(identity)` returns a `BundlePackage` whose `integrity` is
 *     left empty; `buildBundleFromCatalog` recomputes it from the
 *     RECORD entries (same policy as `DbPackageCatalog`).
 *   - Skills and integrations are the draft types it serves (both are bundle
 *     members). Skills are returned as stored. Integrations get the
 *     DB-authoritative draft columns overlaid ({@link applyDraftOverlay}), so
 *     their `INTEGRATION.md` is exactly what the file explorer shows.
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
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import { downloadPackageFiles } from "../package-items/storage.ts";
import { storageFolderForType } from "../package-items/config.ts";
import { applyDraftOverlay } from "../package-files.ts";

interface DraftPackageCatalogOptions {
  /** Org whose draft packages are visible (plus system packages, `orgId IS NULL`). */
  orgId: string;
}

/** Draft types that are bundle members — the only ones a run resolves. */
const DRAFT_BUNDLE_TYPES: ReadonlySet<PackageType> = new Set(["skill", "integration"]);

interface DraftPackageRow {
  draftManifest: unknown;
  draftContent: string | null;
  /** `null` → system package (global `_system/` storage namespace). */
  orgId: string | null;
}

export class DraftPackageCatalog implements PackageCatalog {
  private readonly rowCache = new Map<
    string,
    DraftPackageRow | null | Promise<DraftPackageRow | null>
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
    const type = manifest.type as PackageType;
    if (!DRAFT_BUNDLE_TYPES.has(type)) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `DraftPackageCatalog: ${parsed.packageId} has unsupported type ${String(manifest.type)}`,
        { identity },
      );
    }

    // The package row tells us where the bytes live: `orgId === null` is a
    // system package (global `_system/` namespace), otherwise org-scoped.
    // Passing the hint saves a guaranteed-miss org-path GET for system
    // packages on the run hot path.
    const ownership = row.orgId === null ? "system" : "org";
    const files = await downloadPackageFiles(
      storageFolderForType(type),
      this.opts.orgId,
      parsed.packageId,
      undefined,
      ownership,
    );
    if (!files) {
      throw new BundleError(
        "DEPENDENCY_UNRESOLVED",
        `DraftPackageCatalog: ${parsed.packageId} has no files in storage`,
        { identity },
      );
    }

    // An integration's draft companion lives in `draft_content`, not only in
    // the stored ZIP — overlay it so the run reads what the author sees.
    if (type === "integration") {
      applyDraftOverlay(files, {
        id: parsed.packageId,
        type,
        orgId: row.orgId,
        draftManifest: row.draftManifest,
        draftContent: row.draftContent,
      });
    }

    const fileMap = new Map<string, Uint8Array>();
    for (const [p, bytes] of Object.entries(files)) fileMap.set(p, bytes);

    // Ensure `manifest.json` is materialised since some upload paths only
    // store content files.
    if (!fileMap.has("manifest.json")) {
      fileMap.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    }

    const pkg: BundlePackage = {
      identity,
      manifest,
      files: fileMap,
      integrity: "",
    };
    this.fetchCache.set(identity, pkg);
    return pkg;
  }

  private getPackageRow(packageId: string): Promise<DraftPackageRow | null> {
    const cached = this.rowCache.get(packageId);
    if (cached !== undefined) return Promise.resolve(cached);

    const promise = db
      .select({
        draftManifest: packages.draftManifest,
        draftContent: packages.draftContent,
        orgId: packages.orgId,
      })
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
