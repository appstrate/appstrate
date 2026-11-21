// SPDX-License-Identifier: Apache-2.0

/**
 * Integration package read-side service.
 *
 * Scope (deliberately narrow): read-side queries for the integration package
 * list/detail UI + a thin activation helper. Mutations (connect, OAuth flows)
 * and the runtime credential/spawn path live in their own services.
 */

import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { packages, packageVersions, packageDistTags, spacePackages } from "@appstrate/db/schema";
import { integrationManifestSchema } from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { resolveVersionFromCatalog } from "@appstrate/core/semver";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { BundleError } from "@appstrate/afps-runtime/bundle";
import { canonicalUrl } from "@appstrate/afps-shared/authorized-uris";
import { getSystemPackages } from "./system-packages.ts";
import type { IntegrationSummary } from "@appstrate/shared-types";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { placementReadFilter, placementRowJoin } from "./package-placement.ts";
import { getVersionManifests } from "./package-versions.ts";
import { VERSION_SELECTOR_DRAFT } from "./agent-version-resolver.ts";
import { logger } from "../lib/logger.ts";
import { formatZodIssues } from "../lib/zod-format.ts";
import { likeContains } from "../lib/like-pattern.ts";
import type { DbOrTx } from "../lib/db-helpers.ts";

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/**
 * Discriminated failure modes for {@link fetchIntegrationManifest}.
 * Each caller maps these to its own error shape (throw / null / push to
 * a validation error list) — keeps the helper decoupled from the
 * caller's HTTP semantics.
 */
export type IntegrationManifestLoadFailure =
  | { kind: "not_found" }
  | { kind: "not_integration"; actualType: string }
  /**
   * `issues` is the manifest's Zod validation failure, rendered `path: message`
   * (see `formatZodIssues`). Carried on the failure instead of discarded at the
   * parse site: unlike its two siblings the `invalid_manifest` kind names no
   * fact of its own, so a caller that surfaces it bare ("the manifest is
   * invalid") leaves the operator with nothing to go fix.
   */
  | { kind: "invalid_manifest"; issues: string };

export type IntegrationManifestLoadResult =
  | { ok: true; manifest: IntegrationManifest }
  | { ok: false; failure: IntegrationManifestLoadFailure };

/**
 * Per-call-graph memo for {@link fetchIntegrationManifest}. The run kickoff
 * path loads the SAME integration manifests several times (readiness check →
 * connection-resolution snapshot → spawn resolver); threading one Map through
 * those call sites dedupes the SELECT + Zod parse within a single run trigger.
 *
 * Deliberately NOT a global/TTL cache — the memo's lifetime is one call graph
 * (one run trigger), so a manifest edit is always visible to the next request
 * (no staleness window). Values are promises so concurrent callers within the
 * same graph share one in-flight query instead of racing duplicates.
 */
export type IntegrationManifestCache = Map<string, Promise<IntegrationManifestLoadResult>>;

/**
 * Fetch + validate an integration manifest from `packages.draft_manifest`,
 * unscoped (no orgId filter — internal callers already have an authentication
 * context: a run token, a service-internal call, …). Returns a discriminated
 * union so each caller can map the failure mode to its preferred response.
 *
 * `cache` (optional) memoizes results per packageId for the caller's call
 * graph — see {@link IntegrationManifestCache}. Omitting it preserves the
 * uncached behaviour exactly.
 *
 * The SPACE-scoped reads (the Integrations page's listing and detail) keep
 * their own SELECT in `getIntegration` / `listIntegrations` because they pull
 * additional columns (`orgId`, `source`) under the org+system filter AND the
 * placement conjunct — a single shared helper would force a redundant second
 * roundtrip or leak its SELECT shape.
 */
export async function fetchIntegrationManifest(
  packageId: string,
  cache?: IntegrationManifestCache,
  executor: DbOrTx = db,
): Promise<IntegrationManifestLoadResult> {
  if (!cache) return fetchIntegrationManifestUncached(packageId, executor);
  const hit = cache.get(packageId);
  if (hit) return hit;
  const promise = fetchIntegrationManifestUncached(packageId, executor);
  cache.set(packageId, promise);
  return promise;
}

export function parseIntegrationManifest(raw: unknown): IntegrationManifestLoadResult {
  const parsed = integrationManifestSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      failure: { kind: "invalid_manifest", issues: formatZodIssues(parsed.error) },
    };
  return { ok: true, manifest: parsed.data };
}

async function fetchIntegrationManifestUncached(
  packageId: string,
  executor: DbOrTx = db,
): Promise<IntegrationManifestLoadResult> {
  const [pkgRow] = await executor
    .select({ manifest: packages.draftManifest, type: packages.type })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  return manifestLoadResult(pkgRow);
}

/** A `packages` row (or its absence) answered as an integration manifest load. */
function manifestLoadResult(
  row: { manifest: unknown; type: string } | undefined,
): IntegrationManifestLoadResult {
  if (!row) return { ok: false, failure: { kind: "not_found" } };
  if (row.type !== "integration") {
    return { ok: false, failure: { kind: "not_integration", actualType: row.type } };
  }
  return parseIntegrationManifest(row.manifest);
}

/**
 * Seed `cache` with each of `ids` it lacks, from ONE read, answered as
 * {@link fetchIntegrationManifest} answers a single id.
 */
export function seedIntegrationManifests(
  ids: readonly string[],
  cache: IntegrationManifestCache,
): void {
  const missing = [...new Set(ids)].filter((id) => !cache.has(id));
  if (missing.length === 0) return;
  const rows = db
    .select({ id: packages.id, manifest: packages.draftManifest, type: packages.type })
    .from(packages)
    .where(inArray(packages.id, missing))
    .then((found) => new Map(found.map((row) => [row.id, row])));
  for (const id of missing)
    cache.set(
      id,
      rows.then((byId) => manifestLoadResult(byId.get(id))),
    );
}

// ---------------------------------------------------------------------------
// Spawn-time package version resolution (single kernel)
// ---------------------------------------------------------------------------

/**
 * Discriminated failure modes shared by every spawn-time package resolution.
 * Distinct from "package missing" so callers can log WHY a package was skipped
 * (a silent stale-draft/latest-bytes split is otherwise undiagnosable).
 */
type PublishedManifestFailure =
  | "not_found"
  | "invalid_manifest"
  /** A published version exists, but none satisfied the pin. */
  | "unsatisfiable_pin"
  /** The package exists but has no published version to run. */
  | "no_published_version";

type PublishedManifestResolution =
  | { ok: true; rawManifest: unknown; version: string | null; source: "system" | "version" }
  | { ok: false; reason: PublishedManifestFailure }
  | { ok: false; reason: "wrong_type"; actualType: string };

/**
 * Resolve a package to a CONCRETE published version honoring its pin, and
 * return that version's RAW manifest (unparsed — the caller validates with the
 * schema for its package type). This is the single version-resolution kernel
 * behind the integration spawn path: the manifest comes from `package_versions.manifest` for the SAME
 * `version` the byte route is told to serve, so manifest and bytes can never
 * skew.
 *
 * Resolution order mirrors every other platform catalog: exact → dist-tag →
 * semver range (yanked versions visible only to an exact pin). A missing /
 * empty pin resolves to the `"latest"` dist-tag. System packages short-circuit
 * to the in-memory boot registry (single version, served by id alone).
 *
 * Org-scoped: `orgId` is required and `orgOrSystemFilter` lands in the SQL
 * WHERE of both the package lookup and the version lookup. Package ids are
 * globally unique, so this is defense in depth against a cross-tenant
 * REFERENCE — a run resolving a package id its org neither owns nor gets from
 * the system registry must fail `not_found`, never feed the spawn path —
 * rather than a collision fix (ids cannot collide across orgs).
 */
async function resolvePublishedManifest(
  packageId: string,
  orgId: string,
  pin?: string | null,
  executor: DbOrTx = db,
): Promise<PublishedManifestResolution> {
  // System packages are loaded once at boot and answered from the in-memory
  // registry by id, which holds ONE version per id — so there is no version to
  // pin, and this returns `version: null`. (They do get `package_versions`
  // rows, written by `syncSystemPackagesToDb`; this path simply never consults
  // them.) The byte route short-circuits on the same registry, so
  // manifest and bytes drawn from different versions cannot arise here; that
  // only concerns separately-versioned local packages.
  const sys = getSystemPackages().get(packageId);
  if (sys) {
    return { ok: true, rawManifest: sys.manifest, version: null, source: "system" };
  }

  const [pkgRow] = await executor
    .select({ type: packages.type })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(orgId)))
    .limit(1);
  if (!pkgRow) return { ok: false, reason: "not_found" };
  if (pkgRow.type !== "integration") {
    return { ok: false, reason: "wrong_type", actualType: pkgRow.type };
  }

  const selectVersion = await integrationVersionCatalog([packageId], orgId, executor);
  const selected = selectVersion(packageId, pin);
  if (!selected.ok) return selected;
  const [row] = await executor
    .select({ manifest: packageVersions.manifest, version: packageVersions.version })
    .from(packageVersions)
    .innerJoin(packages, and(eq(packages.id, packageVersions.packageId), orgOrSystemFilter(orgId)))
    .where(eq(packageVersions.id, selected.id))
    .limit(1);
  return row
    ? { ok: true, rawManifest: row.manifest, version: row.version, source: "version" }
    : { ok: false, reason: "not_found" };
}

/**
 * The published (`latest`, unpinned) manifest of each of `ids` that has one, in a constant number
 * of queries. {@link resolvePublishedManifest}'s selection, batched: an id with no published
 * version, of another type, or with an unparsable manifest is absent from the result.
 */
export async function readPublishedIntegrationManifests(
  ids: readonly string[],
  orgId: string,
  executor: DbOrTx = db,
): Promise<Map<string, IntegrationManifest>> {
  const system = getSystemPackages();
  const manifests = new Map<string, IntegrationManifest>();
  const local: string[] = [];
  for (const id of new Set(ids)) {
    const sys = system.get(id);
    if (!sys) {
      local.push(id);
      continue;
    }
    const parsed = parseIntegrationManifest(sys.manifest);
    if (parsed.ok) manifests.set(id, parsed.manifest);
  }
  if (local.length === 0) return manifests;

  const selectVersion = await integrationVersionCatalog(local, orgId, executor);
  const packageOfVersion = new Map<number, string>();
  for (const id of local) {
    const selected = selectVersion(id);
    if (selected.ok) packageOfVersion.set(selected.id, id);
  }
  if (packageOfVersion.size === 0) return manifests;

  const rows = await executor
    .select({ id: packageVersions.id, manifest: packageVersions.manifest })
    .from(packageVersions)
    .innerJoin(
      packages,
      and(
        eq(packages.id, packageVersions.packageId),
        eq(packages.type, "integration"),
        orgOrSystemFilter(orgId),
      ),
    )
    .where(inArray(packageVersions.id, [...packageOfVersion.keys()]));
  for (const row of rows) {
    const parsed = parseIntegrationManifest(row.manifest);
    if (parsed.ok) manifests.set(packageOfVersion.get(row.id)!, parsed.manifest);
  }
  return manifests;
}

/** Load version metadata once for all requested packages. Only selected manifests need loading. */
async function integrationVersionCatalog(ids: string[], orgId: string, executor: DbOrTx = db) {
  const [versions, tags] = await Promise.all([
    executor
      .select({
        packageId: packages.id,
        id: packageVersions.id,
        version: packageVersions.version,
        yanked: packageVersions.yanked,
      })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(
        and(inArray(packages.id, ids), orgOrSystemFilter(orgId), eq(packages.type, "integration")),
      )
      .orderBy(desc(packageVersions.createdAt)),
    executor
      .select({
        packageId: packages.id,
        tag: packageDistTags.tag,
        versionId: packageDistTags.versionId,
      })
      .from(packageDistTags)
      .innerJoin(packages, eq(packages.id, packageDistTags.packageId))
      .where(and(inArray(packages.id, ids), orgOrSystemFilter(orgId))),
  ]);
  const versionsByPackage = Map.groupBy(versions, (row) => row.packageId);
  const tagsByPackage = Map.groupBy(tags, (row) => row.packageId);
  return (packageId: string, pin?: string | null) => {
    const available = versionsByPackage.get(packageId);
    if (!available) return { ok: false, reason: "no_published_version" } as const;
    const id = resolveVersionFromCatalog(
      pin?.trim() || "latest",
      available,
      tagsByPackage.get(packageId) ?? [],
    );
    return id === null
      ? ({ ok: false, reason: "unsatisfiable_pin" } as const)
      : ({ ok: true, id } as const);
  };
}

/** Each agent gets the versions it pins. Matching pins share their load and validation. */
export async function activationManifestCaches(
  manifests: readonly Record<string, unknown>[],
  orgId: string,
) {
  const declarations = manifests.map(parseManifestIntegrations);
  const ids = [...new Set(declarations.flat().map((entry) => entry.id))];
  const system = getSystemPackages();
  const local = ids.filter((id) => !system.has(id));
  const selectVersion = local.length ? await integrationVersionCatalog(local, orgId) : null;
  // A numeric key is an immutable version. A package id is its system definition or the
  // draft fallback used by run readiness when the published pin cannot be resolved.
  const selections = declarations.map((entries) =>
    entries.map(({ id, version }) => {
      const selected = !system.has(id) && selectVersion?.(id, version);
      return { id, key: selected && selected.ok ? selected.id : id };
    }),
  );
  const keys = [...new Set(selections.flat().map(({ key }) => key))];
  const fallbackIds = keys.filter(
    (key): key is string => typeof key === "string" && !system.has(key),
  );
  const [published, fallback] = await Promise.all([
    getVersionManifests(keys.filter((key): key is number => typeof key === "number")),
    fallbackIds.length
      ? db
          .select({ id: packages.id, type: packages.type, manifest: packages.draftManifest })
          .from(packages)
          .where(and(inArray(packages.id, fallbackIds), orgOrSystemFilter(orgId)))
      : [],
  ]);
  const drafts = new Map(fallback.map((row) => [row.id, row]));
  const loaded = new Map<string | number, Promise<IntegrationManifestLoadResult>>();
  for (const key of keys) {
    const result =
      typeof key === "number"
        ? parseIntegrationManifest(published.get(key))
        : manifestLoadResult(system.get(key) ?? drafts.get(key));
    loaded.set(key, Promise.resolve(result));
  }
  return selections.map((entries) => new Map(entries.map(({ id, key }) => [id, loaded.get(key)!])));
}

// ---------------------------------------------------------------------------
// Integration manifest version resolution
// ---------------------------------------------------------------------------

/**
 * Which concrete source an integration manifest is read from for a run. Frozen
 * at kickoff (per declared integration) and reused by every later reader so the
 * spawn spec and the long-lived runtime credential path can never skew.
 *
 *   - `draft`   → the mutable working copy (`packages.draft_manifest`) — opted
 *                 into per-run via `dependency_overrides[id] === "draft"`.
 *   - `system`  → the in-memory boot registry (system integrations).
 *   - `version` → a published `package_versions` row (the pinned version).
 */
type SpawnVersionDescriptor =
  { kind: "draft" } | { kind: "system" } | { kind: "version"; version: string };

/** Frozen resolution recorded on `runs.resolved_integration_versions`. */
export interface ResolvedIntegrationVersion {
  version: string | null;
  source: "version" | "draft" | "system";
}
export type ResolvedIntegrationVersionMap = Record<string, ResolvedIntegrationVersion>;

function descriptorToResolved(d: SpawnVersionDescriptor): ResolvedIntegrationVersion {
  return d.kind === "version"
    ? { version: d.version, source: "version" }
    : { version: null, source: d.kind };
}

/**
 * Map a frozen snapshot entry back into the descriptor the readers consume.
 *
 * `source: "version"` with a null `version` is an impossible shape:
 * {@link descriptorToResolved} is the only writer and it always pairs that
 * source with a concrete semver, so a null there means the stored snapshot is
 * corrupt. It used to substitute `{ kind: "draft" }` — which does NOT mean
 * "the latest published" as the comment claimed, but the MUTABLE draft
 * (`fetchIntegrationManifestUncached`). A run pinned to a version would then
 * have silently spawned and authorized against whatever the draft says today.
 * Throw instead: an unreadable pin is not a degraded read, it is an
 * unanswerable question.
 */
export function resolvedIntegrationVersionToDescriptor(
  packageId: string,
  entry: ResolvedIntegrationVersion,
): SpawnVersionDescriptor {
  switch (entry.source) {
    case "draft":
      return { kind: "draft" };
    case "system":
      return { kind: "system" };
    case "version":
      if (!entry.version) {
        throw new Error(
          `Corrupt frozen integration version for '${packageId}': source "version" with no ` +
            `version (entry: ${JSON.stringify(entry)}). The run's ` +
            `resolved_integration_versions snapshot cannot be honored; re-launch the run to ` +
            `re-freeze it.`,
        );
      }
      return { kind: "version", version: entry.version };
  }
}

/**
 * Read an integration manifest AT a specific resolved version. The single
 * manifest reader for a pinned integration — used both when seeding the
 * kickoff cache and on the runtime credential path (which reads the frozen
 * descriptor off the run row).
 */
export async function readIntegrationManifestAt(
  packageId: string,
  descriptor: SpawnVersionDescriptor,
  executor: DbOrTx = db,
): Promise<IntegrationManifestLoadResult> {
  if (descriptor.kind === "draft") return fetchIntegrationManifestUncached(packageId, executor);

  if (descriptor.kind === "system") {
    const sys = getSystemPackages().get(packageId);
    if (!sys) return { ok: false, failure: { kind: "not_found" } };
    return parseIntegrationManifest(sys.manifest);
  }

  const [row] = await executor
    .select({ manifest: packageVersions.manifest })
    .from(packageVersions)
    .where(
      and(
        eq(packageVersions.packageId, packageId),
        eq(packageVersions.version, descriptor.version),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, failure: { kind: "not_found" } };
  return parseIntegrationManifest(row.manifest);
}

/**
 * Read an integration manifest for a RUN, honoring the version frozen on
 * `runs.resolved_integration_versions`. The single decision point for
 * "frozen version vs draft" — used by every run-scoped reader (credentials
 * resolver, byte-route authz) so the "no frozen entry → draft" fallback lives
 * in ONE place instead of a ternary duplicated per call site.
 *
 *   - `frozen` present → read AT that descriptor (the spawn used the same).
 *   - `frozen` absent (legacy run / soft-resolved integration) → draft, via the
 *     shared per-call-graph `cache` when provided.
 */
export function readIntegrationManifestForRun(
  packageId: string,
  frozen: ResolvedIntegrationVersion | null | undefined,
  cache?: IntegrationManifestCache,
): Promise<IntegrationManifestLoadResult> {
  return frozen
    ? readIntegrationManifestAt(
        packageId,
        resolvedIntegrationVersionToDescriptor(packageId, frozen),
      )
    : fetchIntegrationManifest(packageId, cache);
}

/**
 * The integration manifest a credential-proxy call is authorized against: the version its run
 * froze (`frozen`), else the `latest` published one — the draft only if the run froze it.
 */
export async function readIntegrationManifestForProxy(
  packageId: string,
  orgId: string,
  frozen: ResolvedIntegrationVersion | null,
): Promise<IntegrationManifestLoadResult | { ok: false; failure: { kind: "not_published" } }> {
  if (frozen) return readIntegrationManifestForRun(packageId, frozen);
  const res = await resolvePublishedManifest(packageId, orgId);
  if (res.ok) return parseIntegrationManifest(res.rawManifest);
  if (res.reason === "not_found") return { ok: false, failure: { kind: "not_found" } };
  if (res.reason === "wrong_type") {
    return { ok: false, failure: { kind: "not_integration", actualType: res.actualType } };
  }
  return { ok: false, failure: { kind: "not_published" } };
}

type RunIntegrationVersionsResult =
  | { ok: true; versions: ResolvedIntegrationVersionMap }
  | { ok: false; unresolved: Array<{ name: string; versionSpec: string }> };

/**
 * Resolve EVERY declared integration to a concrete manifest version for a run,
 * honoring each `dependencies.integrations.<id>` pin (and any per-run
 * `dependency_overrides`) against PUBLISHED versions — the integration-axis
 * sibling of `RunPackageCatalog` and the connection cascade snapshot.
 * This is the single point the pin is enforced:
 *
 *   - Seeds the shared `manifestCache` with the resolved manifest keyed by
 *     packageId, so every kickoff reader threading that cache (connection
 *     cascade, spawn resolver, pin checks) honors the pin with NO per-caller
 *     change.
 *   - Returns the frozen `{ version, source }` map to persist on
 *     `runs.resolved_integration_versions`, which the runtime credential path
 *     reads back so a mid-run MITM refresh resolves the SAME version.
 *
 * An unsatisfiable pin (incl. a never-published dependency) is reported as
 * `unresolved` so the caller fails loud with a structured `dependency_unresolved`
 * (422) rather than silently spawning the draft. Soft failures (package
 * missing / wrong type / invalid manifest) are left unseeded — the spawn
 * resolver already drops such integrations with a warning, and the runtime
 * reader falls back to the draft.
 */
export async function resolveRunIntegrationVersions(params: {
  agentManifest: Record<string, unknown>;
  /**
   * The run's org — required tenant boundary for published-version
   * resolution (defense in depth against a cross-tenant reference): a run
   * can only ever resolve a package its org owns or a system package.
   */
  orgId: string;
  dependencyOverrides?: Record<string, string> | null;
  manifestCache?: IntegrationManifestCache;
  executor?: DbOrTx;
}): Promise<RunIntegrationVersionsResult> {
  const entries = parseManifestIntegrations(params.agentManifest);
  const versions: ResolvedIntegrationVersionMap = {};
  const unresolved: Array<{ name: string; versionSpec: string }> = [];
  const seeded: Array<Promise<IntegrationManifestLoadResult>> = [];

  for (const entry of entries) {
    const override = params.dependencyOverrides?.[entry.id];
    let descriptor: SpawnVersionDescriptor;

    if (override === VERSION_SELECTOR_DRAFT) {
      descriptor = { kind: "draft" };
    } else {
      // A non-draft override replaces the manifest pin; otherwise the pin wins.
      const spec = override ?? entry.version;
      const res = await resolvePublishedManifest(entry.id, params.orgId, spec, params.executor);
      if (res.ok) {
        descriptor =
          res.source === "system" ? { kind: "system" } : { kind: "version", version: res.version! };
      } else if (res.reason === "unsatisfiable_pin" || res.reason === "no_published_version") {
        // A real pin that cannot be met — fail loud, never fall back to draft.
        unresolved.push({ name: entry.id, versionSpec: spec || "*" });
        continue;
      } else {
        // not_found / wrong_type / invalid — soft. Leave the cache unseeded so
        // the spawn resolver's own miss-handling skips the integration and the
        // runtime reader falls back to draft.
        logger.info("integration version left unresolved; falling back to draft", {
          integrationId: entry.id,
          reason: res.reason,
        });
        continue;
      }
    }

    // Seed the shared per-run manifest cache so every kickoff reader gets the
    // pinned manifest transparently (one entry per integration, overwriting any
    // draft entry an earlier readiness pass may have memoized).
    if (params.manifestCache) {
      const read = readIntegrationManifestAt(entry.id, descriptor, params.executor);
      params.manifestCache.set(entry.id, read);
      seeded.push(read);
    }
    versions[entry.id] = descriptorToResolved(descriptor);
  }

  // The freeze is complete when this function returns: every seeded read has
  // settled, so a draft saved afterwards cannot reach this run through a read
  // still in flight.
  await Promise.all(seeded);

  if (unresolved.length > 0) return { ok: false, unresolved };
  return { ok: true, versions };
}

/**
 * The frozen map, or the `DEPENDENCY_UNRESOLVED` BundleError (`details.missing`)
 * that `toBundleApiError` renders as `422 dependency_unresolved` — the one
 * place an unresolved integration pin becomes a refusal, for runs and exports.
 */
export function assertIntegrationVersionsResolved(
  result: RunIntegrationVersionsResult,
): ResolvedIntegrationVersionMap {
  if (result.ok) return result.versions;
  throw new BundleError(
    "DEPENDENCY_UNRESOLVED",
    `${result.unresolved.length} integration pin(s) resolved to no published version`,
    { missing: result.unresolved },
  );
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Narrow the JSONB manifest column into the typed view. Returns `null`
 * if the row is not actually an integration manifest — defensive
 * against partial DB writes (e.g. a row whose `type` was migrated but
 * whose manifest hasn't caught up).
 */
function asIntegrationManifest(raw: unknown): IntegrationManifest | null {
  const parsed = integrationManifestSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

/**
 * Fetch a single integration by id, PLACED in the caller's space — homed
 * there, holding a row there, or shipped with the deployment. Returns `null` when
 * absent, out of placement, or when the row has been corrupted enough to fail
 * manifest parsing — the caller should treat all three as `404` for UX
 * consistency.
 *
 * The placement conjunct is {@link placementReadFilter}, the same rule
 * `GET /api/packages/integrations/{id}` and the space library read, stated
 * once in `services/package-placement.ts` rather than a third time here. It is
 * what keeps an integration homed in somebody else's PERSONAL space out of
 * this answer: RBAC spec §3.6 says owners and admins neither read nor write a
 * personal space, and an org-wide read of the manifest — its name, its
 * description, its `authorized_uris` — is a read.
 *
 * Space-scoped, so it is NOT the function that resolves a DECLARED dependency:
 * an agent's `dependencies` resolve against the organization's catalogue
 * org-wide (§6.9), which is {@link getOrgWideIntegrationManifest}.
 */
export async function getIntegration(
  scope: SpaceScope,
  packageId: string,
): Promise<IntegrationSummary | null> {
  const row = await findPlacedIntegrationRow(scope, packageId);
  if (!row) return null;
  const manifest = asIntegrationManifest(row.draftManifest);
  if (!manifest) {
    logger.warn("Integration manifest failed validation; treating as missing", {
      packageId,
    });
    return null;
  }
  return {
    id: row.id,
    manifest,
    orgId: row.orgId,
    source: row.source as "local" | "system",
  };
}

/** The row behind {@link getIntegration}: the integration PLACED in the space, draft unparsed. */
async function findPlacedIntegrationRow(scope: SpaceScope, packageId: string) {
  const [row] = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      source: packages.source,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .where(
      and(
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        placementReadFilter(scope.spaceId),
        eq(packages.id, packageId),
        eq(packages.type, "integration"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type ConnectManifestRead =
  | {
      ok: true;
      manifest: IntegrationManifest;
      /**
       * The published version the manifest was read from, from the same read: the archive a
       * connect-run fetches is that version's. `null` for a system integration (boot registry)
       * and for a draft (nothing published; its files are served).
       */
      version: string | null;
    }
  /** `no_usable_version`: versions exist, none of which resolves as `latest` and parses. */
  | { ok: false; reason: "not_found" | "no_usable_version" };

/**
 * The manifest everything about CONNECTING reads: the connect flows, the auths a space is shown
 * as connectable, and the registration of the OAuth clients those connects use. It is the
 * `latest` published version (a system package's own), and the draft only while nothing is
 * published.
 *
 * A draft changes with no version minted, so once a version exists the endpoints a connect sends
 * an authorization code, a PKCE verifier and the client secret to are read from that version,
 * like the credential proxy ({@link readIntegrationManifestForProxy}). The draft is never a
 * fallback for a published integration, and its own validity plays no part once one exists.
 *
 * With a `spaceId` the integration must be PLACED there ({@link getIntegration}'s rule); without
 * one it is any integration the organization can resolve.
 */
export async function readIntegrationManifestForConnect(
  scope: { orgId: string; spaceId?: string },
  packageId: string,
): Promise<ConnectManifestRead> {
  const placed =
    scope.spaceId !== undefined
      ? await findPlacedIntegrationRow({ orgId: scope.orgId, spaceId: scope.spaceId }, packageId)
      : undefined;
  if (placed === null) return { ok: false, reason: "not_found" };
  const res = await resolvePublishedManifest(packageId, scope.orgId);
  if (res.ok) {
    const parsed = parseIntegrationManifest(res.rawManifest);
    if (parsed.ok) {
      return {
        ok: true,
        manifest: parsed.manifest,
        version: res.source === "version" ? res.version : null,
      };
    }
    logger.warn("Published integration manifest failed validation", {
      packageId,
      version: res.version,
    });
    return { ok: false, reason: "no_usable_version" };
  }
  if (res.reason !== "no_published_version") {
    const missing = res.reason === "not_found" || res.reason === "wrong_type";
    return { ok: false, reason: missing ? "not_found" : "no_usable_version" };
  }
  const draft = placed
    ? asIntegrationManifest(placed.draftManifest)
    : await getOrgWideIntegrationManifest(scope.orgId, packageId);
  return draft ? { ok: true, manifest: draft, version: null } : { ok: false, reason: "not_found" };
}

/**
 * Read the DRAFT manifest of an integration the ORGANIZATION can resolve —
 * org-wide, with no placement conjunct, on purpose.
 *
 * This is the catalogue side of RBAC spec §6.9: a manifest's declared
 * dependencies resolve against the organization's catalogue, not against what
 * the current space happens to be placed in, and the run resolves them exactly
 * that way (`resolveRunIntegrationVersions` → `resolvePublishedManifest`,
 * `orgId` and nothing else). A validator narrower than the runtime it gates
 * would wave through selections the spawn then refuses, so this deliberately
 * asks the wider question that {@link getIntegration} refuses to ask.
 *
 * Returns `null` when the id names no integration of this organization, or
 * when its manifest does not parse — both mean "nothing to judge against" to
 * its callers (scope validation, and the org tier of OAuth clients).
 */
export async function getOrgWideIntegrationManifest(
  orgId: string,
  packageId: string,
): Promise<IntegrationManifest | null> {
  const [row] = await db
    .select({ draftManifest: packages.draftManifest })
    .from(packages)
    .where(
      and(
        orgOrSystemFilter(orgId),
        notEphemeralFilter(),
        eq(packages.id, packageId),
        eq(packages.type, "integration"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return asIntegrationManifest(row.draftManifest);
}

/**
 * List every integration PLACED in the caller's space — homed there, holding a
 * row there, or shipped with the deployment. Manifests that fail validation are
 * skipped (with a structured warning) rather than aborting the whole query —
 * one broken row shouldn't hide the rest.
 *
 * Placement, not activation: a package switched off is still placed, and this
 * listing decorates each row with its own `active` flag afterwards. The conjunct is {@link
 * placementReadFilter} — the same rule the per-type index and the space
 * library read — so an integration homed in a PERSONAL space of somebody else
 * never reaches the response, whatever the caller's organization role
 * (RBAC spec §3.6).
 */
/**
 * Narrowing of {@link listIntegrations}, combined with the placement rule.
 * `ids`: only these package ids (an id not placed here is absent, never an
 * error). `search`: case-insensitive substring of the id, the manifest's
 * `display_name` or its `description`, taken as typed.
 */
export interface IntegrationListFilters {
  ids?: readonly string[];
  search?: string;
}

export async function listIntegrations(
  scope: SpaceScope,
  filters: IntegrationListFilters = {},
): Promise<IntegrationSummary[]> {
  const pattern = filters.search ? likeContains(filters.search) : undefined;
  const rows = await db
    .select({
      id: packages.id,
      orgId: packages.orgId,
      source: packages.source,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .where(
      and(
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        placementReadFilter(scope.spaceId),
        eq(packages.type, "integration"),
        // An empty list would be `IN ()`, SQL for "nothing", where the caller meant no filter.
        filters.ids?.length ? inArray(packages.id, [...filters.ids]) : undefined,
        pattern
          ? or(
              ilike(packages.id, pattern),
              ilike(sql`${packages.draftManifest}->>'display_name'`, pattern),
              ilike(sql`${packages.draftManifest}->>'description'`, pattern),
            )
          : undefined,
      ),
    )
    // The route paginates this in memory: a stable order keeps pages disjoint.
    .orderBy(packages.id);

  const out: IntegrationSummary[] = [];
  for (const row of rows) {
    const manifest = asIntegrationManifest(row.draftManifest);
    if (!manifest) {
      logger.warn("Skipping integration row with invalid manifest", { packageId: row.id });
      continue;
    }
    out.push({
      id: row.id,
      manifest,
      orgId: row.orgId,
      source: row.source as "local" | "system",
    });
  }
  return out;
}

/**
 * The integrations {@link listIntegrations} shows in `scope` whose remote MCP server is `url`:
 * equal after {@link canonicalUrl}, nothing looser. Ordered by package id.
 */
export async function listIntegrationsAtRemoteUrl(
  scope: SpaceScope,
  url: string,
): Promise<IntegrationSummary[]> {
  const target = canonicalUrl(url);
  if (!target) return [];
  const summaries = await listIntegrations(scope);
  return summaries.filter(({ manifest }) => {
    const source = manifest.source;
    return source?.kind === "remote" && canonicalUrl(source.remote.url) === target;
  });
}
