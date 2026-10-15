// SPDX-License-Identifier: Apache-2.0

/**
 * {@link RunPackageCatalog} — the `PackageCatalog` used on the run hot
 * path by `buildAgentPackage`.
 *
 * Unlike the old run-path catalog (which resolved every dependency
 * against the mutable DRAFT state and ignored the manifest pin), this
 * catalog resolves the agent's transitive closure against PUBLISHED
 * versions, honoring each dependency's pin (exact → dist-tag → semver
 * range) via {@link DbPackageCatalog}. A run
 * gets the published bytes the manifest pin selects, NOT whatever the
 * dependency author happens to have in their working copy.
 *
 * Reproducibility contract:
 *   - A draft OR published agent run resolves `dependencies.skills`
 *     against the registry. The same manifest pin means the same bytes
 *     on every run, matching the export path (`assembleAgentBundle` in
 *     package-storage.ts).
 *   - An unsatisfiable skill pin (including a never-published dependency)
 *     surfaces as a `DEPENDENCY_UNRESOLVED` BundleError from the bundle
 *     builder — never a silent draft fallback.
 *   - `dependencies.integrations` never resolves a version here: the run
 *     already froze one per integration (`integrationVersions`, persisted as
 *     `runs.resolved_integration_versions`) and the bundle carries exactly
 *     that — a published version, the draft, or the system registry's
 *     entry. A `system` member is served from the boot registry's in-memory
 *     archive, the same bytes the spawn resolver reads, never a stored copy
 *     that could drift without a version bump (system packages are exempt
 *     from the signature policy, so nothing is skipped). An integration
 *     absent from the freeze resolves to `null`.
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
 *   consumed draft bytes is never mistaken for a reproducible one. They do
 *   not apply to integrations here: the freeze has already folded them in.
 *
 * `fetch` is routed to whichever backing catalog produced the identity
 * during `resolve` (the bundle builder always resolves before fetching).
 * A fetch for an un-resolved identity falls back to the DB catalog — EXCEPT
 * for a dependency the caller pinned to `draft`: serving published bytes for
 * a draft override would silently break the override, so an owner-miss on a
 * draft-overridden dep (or an integration frozen as `draft`) throws loud instead.
 */

import {
  extractRootFromAfps,
  formatPackageIdentity,
  type BundlePackage,
  type DependencySection,
  type PackageCatalog,
  type PackageIdentity,
  type ResolvedPackage,
} from "@appstrate/afps-runtime/bundle";
import { DbPackageCatalog } from "./db-package-catalog.ts";
import { DraftPackageCatalog } from "./draft-package-catalog.ts";
import { VERSION_SELECTOR_DRAFT } from "../agent-version-resolver.ts";
import {
  resolvedIntegrationVersionToDescriptor,
  type ResolvedIntegrationVersionMap,
} from "../integration-service.ts";
import { getSystemPackages, type SystemPackageEntry } from "../system-packages.ts";

type SystemArchive = Pick<SystemPackageEntry, "version" | "zipBuffer">;

interface RunPackageCatalogOptions {
  /** Org whose packages are visible (plus system packages, `orgId IS NULL`). */
  orgId: string;
  /**
   * Per-dependency run-scoped overrides: `{ "@scope/name": "draft" | <spec> }`.
   * `"draft"` routes that dependency to the draft catalog; any other value
   * replaces the manifest pin with that spec against published versions.
   */
  dependencyOverrides?: Record<string, string> | null;
  /** The run's frozen integration versions — the only source for `integrations`. */
  integrationVersions: ResolvedIntegrationVersionMap;
  /** The bundle will run (AFPS signature policy on published fetches); false for an export. */
  forExecution: boolean;
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
    /** The system registry's entry for a package id (boot registry by default). */
    systemPackage?: (packageId: string) => SystemArchive | undefined;
  };
}

export class RunPackageCatalog implements PackageCatalog {
  private readonly db: PackageCatalog;
  private readonly makeDraft: () => PackageCatalog;
  /** Created lazily — most runs declare no `draft` override at all. */
  private draftCatalog: PackageCatalog | null = null;
  private readonly overrides: Map<string, string>;
  private readonly integrationVersions: ResolvedIntegrationVersionMap;
  private readonly systemPackage: (packageId: string) => SystemArchive | undefined;
  /** identity → whatever resolved it (routes `fetch`). */
  private readonly owners = new Map<PackageIdentity, Pick<PackageCatalog, "fetch">>();

  constructor(opts: RunPackageCatalogOptions) {
    this.db =
      opts.deps?.db ?? new DbPackageCatalog({ orgId: opts.orgId, forExecution: opts.forExecution });
    this.makeDraft = opts.deps?.makeDraft ?? (() => new DraftPackageCatalog({ orgId: opts.orgId }));
    this.overrides = new Map(Object.entries(opts.dependencyOverrides ?? {}));
    this.integrationVersions = opts.integrationVersions;
    this.systemPackage = opts.deps?.systemPackage ?? ((id) => getSystemPackages().get(id));
  }

  private draft(): PackageCatalog {
    return (this.draftCatalog ??= this.makeDraft());
  }

  async resolve(
    name: string,
    versionSpec: string,
    section: DependencySection,
  ): Promise<ResolvedPackage | null> {
    if (section === "integrations") return this.resolveIntegration(name, versionSpec, section);

    const override = this.overrides.get(name);
    if (override === VERSION_SELECTOR_DRAFT)
      return this.resolveVia(this.draft(), name, versionSpec, section);

    // No override → manifest pin; explicit spec override → replaces the pin.
    // Both resolve against published versions via the DB catalog.
    return this.resolveVia(this.db, name, override ?? versionSpec, section);
  }

  /** Answer from the run's freeze only — the manifest pin was already applied by it. */
  private async resolveIntegration(
    name: string,
    versionSpec: string,
    section: DependencySection,
  ): Promise<ResolvedPackage | null> {
    const entry = this.integrationVersions[name];
    if (!entry) return null;
    const descriptor = resolvedIntegrationVersionToDescriptor(name, entry);
    switch (descriptor.kind) {
      case "draft":
        return this.resolveVia(this.draft(), name, versionSpec, section);
      case "version":
        return this.resolveVia(this.db, name, descriptor.version, section);
      case "system":
        return this.resolveSystem(name);
    }
  }

  /**
   * Serve the registry's archive as-is. Unzipping a system integration (a
   * manifest and a markdown file) in memory is negligible next to the DB +
   * storage round-trips it replaces, so nothing is cached across runs.
   */
  private resolveSystem(name: string): ResolvedPackage | null {
    const system = this.systemPackage(name);
    if (!system) return null;
    const identity = formatPackageIdentity(name as `@${string}/${string}`, system.version);
    this.owners.set(identity, {
      fetch: async () => extractRootFromAfps(new Uint8Array(system.zipBuffer)),
    });
    return { identity, integrity: null };
  }

  private async resolveVia(
    cat: PackageCatalog,
    name: string,
    spec: string,
    section: DependencySection,
  ): Promise<ResolvedPackage | null> {
    const resolved = await cat.resolve(name, spec, section);
    if (resolved) this.owners.set(resolved.identity, cat);
    return resolved;
  }

  async fetch(identity: PackageIdentity): Promise<BundlePackage> {
    const owner = this.owners.get(identity);
    if (owner) return owner.fetch(identity);

    // Owner miss — the builder fetched an identity it never resolved through
    // us (defensive; resolve-before-fetch normally populates `owners`). DB
    // fallback is safe for a published dep, but for one the caller pinned to
    // `draft` it would silently serve PUBLISHED bytes. Keep "draft must be
    // draft" loud rather than quietly swapping bytes. Identity shape is
    // `@scope/name@version`, so the name is everything before the last `@`.
    const name = identity.slice(0, identity.lastIndexOf("@"));
    if (
      this.overrides.get(name) === VERSION_SELECTOR_DRAFT ||
      this.integrationVersions[name]?.source === "draft"
    ) {
      throw new Error(
        `RunPackageCatalog: draft-overridden dependency '${name}' fetched without a recorded resolver — refusing to serve published bytes for a draft override`,
      );
    }
    return this.db.fetch(identity);
  }
}
