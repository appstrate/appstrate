// SPDX-License-Identifier: Apache-2.0

/**
 * {@link RunPackageCatalog} — the `PackageCatalog` used on the run hot
 * path by `buildAgentPackage`.
 *
 * Unlike the old run-path catalog (which resolved every dependency
 * against the mutable DRAFT state and ignored the manifest pin), this
 * catalog resolves the agent's transitive closure against PUBLISHED
 * versions, honoring each dependency's pin (exact → dist-tag → semver
 * range) via {@link DbPackageCatalog}. This is the fix for #666: a run
 * gets the published bytes the manifest pin selects, NOT whatever the
 * dependency author happens to have in their working copy.
 *
 * Reproducibility contract:
 *   - A draft OR published agent run resolves `dependencies.skills`
 *     against the registry. The same manifest pin means the same bytes
 *     on every run, matching the export/import path (`buildBundleFromDb`).
 *   - An unsatisfiable pin (including a never-published dependency)
 *     surfaces as a `DEPENDENCY_UNRESOLVED` BundleError from the bundle
 *     builder — never a silent draft fallback.
 *
 * Escape hatch — per-run dependency overrides:
 *   The `dependencyOverrides` map (`{ "@scope/name": "draft" | <spec> }`)
 *   lets a single run opt a dependency out of the published-only rule:
 *     - `"draft"` → resolve that dependency against its mutable draft
 *       (the skill-development edit loop: edit SKILL.md → run → observe,
 *       no republish per iteration). Routed to {@link DraftPackageCatalog}.
 *     - any other value → treated as an explicit version spec (exact /
 *       dist-tag / semver range) that REPLACES the manifest pin for that
 *       dependency, still resolved against published versions.
 *   Overrides are run-scoped only — never stored in the manifest — and are
 *   persisted on the run row (`runs.dependency_overrides`) so a run that
 *   consumed draft bytes is never mistaken for a reproducible one.
 *
 * `fetch` is routed to whichever backing catalog produced the identity
 * during `resolve` (the bundle builder always resolves before fetching).
 * A fetch for an un-resolved identity falls back to the DB catalog.
 */

import {
  type BundlePackage,
  type PackageCatalog,
  type PackageIdentity,
  type ResolvedPackage,
} from "@appstrate/afps-runtime/bundle";
import { DbPackageCatalog } from "./db-package-catalog.ts";
import { DraftPackageCatalog } from "./draft-package-catalog.ts";
import { VERSION_SELECTOR_DRAFT } from "../agent-version-resolver.ts";

export interface RunPackageCatalogOptions {
  /** Org whose packages are visible (plus system packages, `orgId IS NULL`). */
  orgId: string;
  /**
   * Per-dependency run-scoped overrides: `{ "@scope/name": "draft" | <spec> }`.
   * `"draft"` routes that dependency to the draft catalog; any other value
   * replaces the manifest pin with that spec against published versions.
   */
  dependencyOverrides?: Record<string, string> | null;
  /**
   * Injection seam for tests (the repo's no-`mock.module` DI policy). Supply
   * stand-in catalogs to exercise the routing logic without DB/storage. The
   * draft factory is lazy so production runs that declare no `draft` override
   * never construct a `DraftPackageCatalog`. Production defaults wrap the real
   * {@link DbPackageCatalog} / {@link DraftPackageCatalog}.
   */
  deps?: {
    db?: PackageCatalog;
    makeDraft?: () => PackageCatalog;
  };
}

export class RunPackageCatalog implements PackageCatalog {
  private readonly db: PackageCatalog;
  private readonly makeDraft: () => PackageCatalog;
  /** Created lazily — most runs declare no `draft` override at all. */
  private draftCatalog: PackageCatalog | null = null;
  private readonly overrides: Map<string, string>;
  /** identity → the backing catalog that resolved it (routes `fetch`). */
  private readonly owners = new Map<PackageIdentity, PackageCatalog>();

  constructor(opts: RunPackageCatalogOptions) {
    this.db = opts.deps?.db ?? new DbPackageCatalog({ orgId: opts.orgId });
    this.makeDraft = opts.deps?.makeDraft ?? (() => new DraftPackageCatalog({ orgId: opts.orgId }));
    this.overrides = new Map(Object.entries(opts.dependencyOverrides ?? {}));
  }

  private draft(): PackageCatalog {
    return (this.draftCatalog ??= this.makeDraft());
  }

  async resolve(name: string, versionSpec: string): Promise<ResolvedPackage | null> {
    const override = this.overrides.get(name);

    if (override === VERSION_SELECTOR_DRAFT) {
      const cat = this.draft();
      const resolved = await cat.resolve(name, versionSpec);
      if (resolved) this.owners.set(resolved.identity, cat);
      return resolved;
    }

    // No override → manifest pin; explicit spec override → replaces the pin.
    // Both resolve against published versions via the DB catalog.
    const effectiveSpec = override ?? versionSpec;
    const resolved = await this.db.resolve(name, effectiveSpec);
    if (resolved) this.owners.set(resolved.identity, this.db);
    return resolved;
  }

  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    const owner = this.owners.get(identity) ?? this.db;
    return owner.fetch(identity);
  }
}
