// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level package management — activate, deactivate, list, and configure
 * packages within a space context.
 *
 * `space_packages` is the placement: one row per (package, space) carrying
 * `enabled`, model, proxy and input settings (RBAC spec §6.10). The doors here
 * create rows; outside the home only {@link placePackage} does. Deactivating
 * keeps the row; only `withdrawPlacement` deletes it.
 */

import { eq, and, inArray, sql } from "drizzle-orm";
import type { AnyPgColumn, PgSelect } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import {
  spacePackages,
  packages,
  packageDistTags,
  packageVersions,
  spaces,
} from "@appstrate/db/schema";
import {
  conflict,
  forbidden,
  invalidRequest,
  notFound,
  parseBody,
  type ResolutionFieldError,
} from "../lib/errors.ts";
import { inputSettingsSchema } from "../lib/jsonb-schemas.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { OrgScope, SpaceScope } from "../lib/scope.ts";
import { assertSpaceInScope, spaceListingOrder } from "./spaces.ts";
import { listOrgOffers, placementReadFilter, placementRowJoin } from "./package-placement.ts";
import { getLatestVersionId } from "./package-versions.ts";
import {
  inactiveDeclaredIntegrations,
  inactiveRequiredIntegrationIds,
  integrationNotActiveMessage,
  translateResolutionError,
} from "./integration-connection-resolver.ts";
import {
  latestTagJoin,
  selectorlessAgentManifest,
  selectorlessLaunchManifests,
} from "./agent-version-resolver.ts";
import {
  activeHereSql,
  isActiveHere,
  isActiveWithoutRow,
  type ActivatablePackage,
} from "./package-activation.ts";
import { listRuntimeBoundSystemIntegrationIds } from "./system-packages.ts";

// ---------------------------------------------------------------------------
// Activate / Deactivate
// ---------------------------------------------------------------------------

/** The placement row of `(space, package)`, `FOR UPDATE` so a concurrent withdrawal cannot delete it under a door's decision. */
async function currentPlacement(tx: Tx, packageId: string, spaceId: string) {
  const [row] = await tx
    .select()
    .from(spacePackages)
    .where(and(eq(spacePackages.spaceId, spaceId), eq(spacePackages.packageId, packageId)))
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * The catalog row every door starts from, or an opaque 404. `FOR SHARE` because
 * `home_space_id` decides whether a row may be created and a home move rewrites
 * it. `lock: "update"` is for the one writer of the organization's offer, which
 * serializes against every row writer (they all hold `FOR SHARE`). The offer is
 * read AFTER the lock, in a statement of its own, so it is current. Lock order:
 * `packages`, then the `space_packages` row.
 */
export async function loadPlaceablePackage(
  tx: Tx,
  scope: OrgScope,
  packageId: string,
  lock: "share" | "update" = "share",
) {
  const [pkg] = await tx
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      draftManifest: packages.draftManifest,
    })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
    .limit(1)
    .for(lock);
  if (!pkg) throw notFound(`Package '${packageId}' not found in this organization`);
  const offeredToOrg = (await listOrgOffers(scope.orgId, [packageId], tx)).has(packageId);
  return { ...pkg, offeredToOrg };
}

/** Placed here without a row — shipped with the deployment, homed here, or offered to the organization. */
function placedWithoutRow(
  pkg: { source: string | null; homeSpaceId: string | null; offeredToOrg: boolean },
  spaceId: string,
): boolean {
  return pkg.source === "system" || pkg.homeSpaceId === spaceId || pkg.offeredToOrg;
}

/** The agent and its local decision stay locked until the schedule insert or re-arm commits. */
export async function assertScheduleAgentActive(tx: Tx, scope: SpaceScope, packageId: string) {
  const pkg = await loadPlaceablePackage(tx, scope, packageId);
  const placement = await currentPlacement(tx, packageId, scope.spaceId);
  if (!isActiveHere(pkg, placement)) {
    throw notFound(
      `Agent '${packageId}' is unavailable for scheduling in this space. Activate it before enabling a schedule.`,
    );
  }
}

/**
 * Does a row this door creates in `spaceId` exist only because of the offer? A
 * row outside the home of an organization package is placed by nothing else
 * here (a real placement is `placePackage`'s), so it decides about the offer
 * and goes when the offer does (`placed_by_offer`).
 */
function offerOnlyRow(pkg: { source: string | null; homeSpaceId: string | null }, spaceId: string) {
  return pkg.source !== "system" && pkg.homeSpaceId !== spaceId;
}

/** Who places a package outside its home: recorded as `shared_by`, plus the route's `<type>:share` rule as a predicate, judged against the locked home. */
export interface PlacementAuthority {
  sharedBy: string;
  authorizeHome: (homeSpaceId: string | null) => boolean;
}

/**
 * The one door that creates a row outside the home (RBAC spec §6.10). Refuses
 * 403 without `<type>:share` in the locked home (checked first, so a caller who
 * no longer governs the package learns nothing), 409 `share_target_is_home`,
 * 409 `package_has_no_version`. `pkg` comes from `loadPlaceablePackage` in this
 * transaction. Returns `null` when a row already existed (left untouched).
 */
export async function placePackage(
  tx: Tx,
  pkg: { id: string; homeSpaceId: string | null },
  spaceId: string,
  params: PlacementAuthority & { enabled: boolean },
) {
  if (!params.authorizeHome(pkg.homeSpaceId)) {
    throw forbidden(
      `Placing '${pkg.id}' requires the share permission in its home space — the package moved home while this request was in flight.`,
    );
  }
  if (pkg.homeSpaceId === spaceId) {
    throw conflict(
      "share_target_is_home",
      "This package already lives in that space — sharing it there would place it in itself.",
    );
  }
  await assertHasPublishedVersion(pkg.id, tx);
  const [row] = await tx
    .insert(spacePackages)
    .values({ spaceId, packageId: pkg.id, enabled: params.enabled, sharedBy: params.sharedBy })
    // A row left by the offer becomes a real placement (keeping its `enabled`
    // and settings); any other existing row is left untouched.
    .onConflictDoUpdate({
      target: [spacePackages.spaceId, spacePackages.packageId],
      set: { placedByOffer: false, sharedBy: params.sharedBy },
      setWhere: eq(spacePackages.placedByOffer, true),
    })
    .returning();
  return row ?? null;
}

/** 409 `package_has_no_version` unless a version is published; {@link placePackage}'s precondition, exported so callers can ask before a side effect. */
export async function assertHasPublishedVersion(packageId: string, executor: DbOrTx = db) {
  if ((await getLatestVersionId(packageId, executor)) === null) {
    throw conflict(
      "package_has_no_version",
      `Package '${packageId}' has no published version — publish one first, since a package runs its latest published version outside the space that owns it.`,
    );
  }
}

/** The placement as the wire names it, built from the rows just written (a re-read could describe another call's act); same shape as {@link spacePackageSelect}. */
function spacePackageWire(
  row: typeof spacePackages.$inferSelect,
  pkg: { type: PackageType; source: string | null; draftManifest: unknown },
) {
  return {
    packageId: row.packageId,
    generation_config: row.generationConfig,
    modelId: row.modelId,
    proxyId: row.proxyId,
    enabled: row.enabled,
    installed_at: row.installedAt,
    updatedAt: row.updatedAt,
    package_type: pkg.type,
    package_source: pkg.source,
    draft_manifest: pkg.draftManifest,
  };
}

/** What one call to {@link activatePackage} did. */
export interface PackageActivation {
  /** The placement row as it now stands, projected for the wire. */
  placement: ReturnType<typeof spacePackageWire>;
  /** Whether THIS call created the placement row. */
  created: boolean;
  /** Whether THIS call placed the package here through {@link placePackage}. */
  shared: boolean;
  /** Whether the package was ALREADY active here when the call arrived. */
  wasActive: boolean;
}

/**
 * Activate a package in a space: the one door, an upsert that keeps the row's
 * settings (RBAC spec §6.10). An existing row is switched on; with none, the
 * row is created where the package is placed without one (home, system) and
 * elsewhere only via {@link placePackage} with `placeAs`. Without `placeAs` the
 * answer is a 404, never a 403 (the id may be private). `shared` and `wasActive`
 * report what this call did, so audits never claim an act that did not happen.
 */
export async function activatePackage(
  scope: SpaceScope,
  packageId: string,
  opts?: { placeAs?: PlacementAuthority },
): Promise<PackageActivation> {
  await assertSpaceInScope(scope);

  // One transaction: the org-visibility check is atomic with the write.
  return db.transaction((tx) => activatePackageWithin(tx, scope, packageId, opts));
}

/**
 * {@link activatePackage}'s body inside the caller's transaction, for the home
 * move; the caller has already run {@link assertSpaceInScope}. `keepExistingDecision` leaves a
 * destination's existing on/off verdict alone (a move transfers authority, not
 * what a space runs).
 */
export async function activatePackageWithin(
  tx: Tx,
  scope: SpaceScope,
  packageId: string,
  opts?: {
    placeAs?: PlacementAuthority;
    keepExistingDecision?: boolean;
  },
): Promise<PackageActivation> {
  const pkg = await loadPlaceablePackage(tx, scope, packageId);
  const existing = await currentPlacement(tx, packageId, scope.spaceId);
  // The activation rule, read before the write.
  const wasActive = isActiveHere(pkg, existing);
  const switchOn = async (created: boolean, shared: boolean) => {
    const [row] = await tx
      .update(spacePackages)
      .set({ enabled: true, updatedAt: new Date() })
      .where(and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)))
      .returning();
    if (!row) throw notFound(`Package '${packageId}' is not placed in this space`);
    return { placement: spacePackageWire(row, pkg), created, shared, wasActive };
  };

  if (existing) {
    if (opts?.keepExistingDecision) {
      return {
        placement: spacePackageWire(existing, pkg),
        created: false,
        shared: false,
        wasActive,
      };
    }
    return switchOn(false, false);
  }

  if (placedWithoutRow(pkg, scope.spaceId)) {
    // Upsert: two racing first activations both read no row, and the loser
    // must not 500. `created` may then be true on both sides (one duplicate audit).
    const [row] = await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
        enabled: true,
        placedByOffer: offerOnlyRow(pkg, scope.spaceId),
      })
      .onConflictDoUpdate({
        target: [spacePackages.spaceId, spacePackages.packageId],
        set: opts?.keepExistingDecision
          ? { updatedAt: new Date() }
          : { enabled: true, updatedAt: new Date() },
      })
      .returning();
    if (!row) throw notFound(`Package '${packageId}' is not placed in this space`);
    return { placement: spacePackageWire(row, pkg), created: true, shared: false, wasActive };
  }

  if (!opts?.placeAs) throw notFound(`Package '${packageId}' not found in this organization`);
  const placed = await placePackage(tx, pkg, scope.spaceId, { ...opts.placeAs, enabled: true });
  if (placed) {
    return { placement: spacePackageWire(placed, pkg), created: true, shared: true, wasActive };
  }
  // A concurrent call placed it first: switch that row on, like any other.
  return switchOn(false, false);
}

/** A declared integration not active where the agent is now on (`warnings[]` of an activation). */
export type ActivationWarning = ResolutionFieldError & { required: boolean };

/**
 * Declared integrations of an agent not active in `spaceId` (`[]` for any other
 * `type`); activates nothing, since that opens credentials to the space.
 */
export async function activationWarnings(
  scope: SpaceScope,
  packageId: string,
  type: PackageType,
): Promise<ActivationWarning[]> {
  if (type !== "agent") return [];
  const manifest = await selectorlessAgentManifest(packageId);
  if (!manifest) return [];
  const [inactive] = await inactiveDeclaredIntegrations([manifest], scope);
  return inactive!.map(({ integrationId, required }) => ({
    ...translateResolutionError({
      integrationId,
      code: "integration_not_active",
      message: `${integrationNotActiveMessage(integrationId, scope.spaceId)}; ${
        required
          ? "a launch of this agent here is refused until then."
          : "the run proceeds without it."
      }`,
    }),
    required,
  }));
}

/** 404 unless the deployment default switches the package on with no row. */
function assertActiveWithoutRow(pkg: ActivatablePackage, packageId: string): void {
  if (!isActiveWithoutRow(pkg)) {
    throw notFound(`Package '${packageId}' is not active in this space`);
  }
}

/**
 * Deactivate a package in a space: `enabled = false`, the row and its settings
 * kept. With no row, a default-on package gets a row saying `false` (the sticky
 * opt-out); otherwise 404. `changed` says whether the space's answer moved.
 */
export async function deactivatePackage(
  scope: SpaceScope,
  packageId: string,
): Promise<{ changed: boolean }> {
  await assertSpaceInScope(scope);
  if (listRuntimeBoundSystemIntegrationIds().includes(packageId)) {
    throw invalidRequest(
      `'${packageId}' serves the run's own tools and stays active in every space.`,
    );
  }

  return db.transaction(async (tx) => {
    const pkg = await loadPlaceablePackage(tx, scope, packageId);
    const existing = await currentPlacement(tx, packageId, scope.spaceId);
    const wasActive = isActiveHere(pkg, existing);

    if (existing) {
      if (existing.enabled) {
        await tx
          .update(spacePackages)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)),
          );
      }
      return { changed: wasActive };
    }

    assertActiveWithoutRow(pkg, packageId);

    await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
        enabled: false,
        placedByOffer: offerOnlyRow(pkg, scope.spaceId),
      })
      .onConflictDoUpdate({
        target: [spacePackages.spaceId, spacePackages.packageId],
        set: { enabled: false, updatedAt: new Date() },
      });
    return { changed: wasActive };
  });
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

// `input_settings` is deliberately not projected: it is read via `AgentDetail.input`.
const spacePackageSelect = {
  packageId: spacePackages.packageId,
  generation_config: spacePackages.generationConfig,
  modelId: spacePackages.modelId,
  proxyId: spacePackages.proxyId,
  enabled: spacePackages.enabled,
  installed_at: spacePackages.installedAt,
  updatedAt: spacePackages.updatedAt,
  package_type: packages.type,
  package_source: packages.source,
  draft_manifest: packages.draftManifest,
};

/** Every placement row of a space — active and inactive alike. */
export async function listSpacePackages(scope: SpaceScope, type?: PackageType) {
  // `orgOrSystemFilter`: a stray row pointing at another org's package must not
  // surface that package — the projection carries `draft_manifest`.
  const conditions = [eq(spacePackages.spaceId, scope.spaceId), orgOrSystemFilter(scope.orgId)];
  if (type) {
    conditions.push(eq(packages.type, type));
  }

  return db
    .select(spacePackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(and(...conditions));
}

export async function getSpacePackage(scope: SpaceScope, packageId: string) {
  // Org filter in the WHERE: never an existence oracle.
  const [row] = await db
    .select(spacePackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
      ),
    )
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Active packages in a space (single query)
// ---------------------------------------------------------------------------

/**
 * WHERE for "active in this space, of this `type`", org-or-system owned, never
 * an ephemeral shadow. Expects the `spacePackages` join of {@link activeHereSql},
 * which index pages, hints and the run gate all share.
 */
export function activePackagesFilter(
  scope: OrgScope,
  type: PackageType,
  spaceId: string | AnyPgColumn,
) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    activeHereSql(spaceId),
  );
}

/**
 * Narrow `query` (a `$dynamic()` select from `packages`) to the packages of one
 * `type` active in any of `spaceIds`, one row per package ({@link activeSpaceIds}
 * names the spaces). A column `query` selects beyond `packages`' own goes in
 * `groupBy`.
 */
export function activeInSpaces<Q extends PgSelect>(
  query: Q,
  orgId: string,
  spaceIds: readonly string[],
  type: PackageType,
  groupBy: AnyPgColumn[] = [],
) {
  return joinSpacePlacements(query, orgId, spaceIds)
    .where(activePackagesFilter({ orgId }, type, spaces.id))
    .groupBy(packages.id, ...groupBy);
}

/** `query` (a `$dynamic()` select from `packages`) per space of `spaceIds`, with its placement row if any. */
function joinSpacePlacements<Q extends PgSelect>(
  query: Q,
  orgId: string,
  spaceIds: readonly string[],
) {
  return query
    .innerJoin(spaces, and(eq(spaces.orgId, orgId), inArray(spaces.id, [...spaceIds])))
    .leftJoin(spacePackages, placementRowJoin(packages.id, spaces.id));
}

/** Org-or-system, never an ephemeral shadow, placed in the joined space. */
function readablePlacementFilter(orgId: string) {
  return and(orgOrSystemFilter(orgId), notEphemeralFilter(), placementReadFilter(spaces.id));
}

/** Readable placements, including switched-off ones, in home-first space listing order. */
export async function packagePlacementsInSpaces(
  orgId: string,
  packageId: string,
  spaceIds: readonly string[],
  type: PackageType,
) {
  if (!spaceIds.length) return [];
  const query = db
    .select({ id: spaces.id, active: sql<boolean>`${activeHereSql(spaces.id)}` })
    .from(packages)
    .$dynamic();
  return joinSpacePlacements(query, orgId, spaceIds)
    .where(and(eq(packages.id, packageId), eq(packages.type, type), readablePlacementFilter(orgId)))
    .orderBy(sql`(${spaces.id} = ${packages.homeSpaceId}) IS TRUE DESC`, ...spaceListingOrder());
}

/** All readable placements of the requested packages in the candidate spaces, including switched-off placements. */
export async function listPackagePlacements(
  orgId: string,
  packageIds: string[],
  spaceIds: string[],
  type: PackageType,
) {
  const query = db.select({ packageId: packages.id, spaceId: spaces.id }).from(packages).$dynamic();
  return joinSpacePlacements(query, orgId, spaceIds)
    .where(
      and(
        inArray(packages.id, packageIds),
        eq(packages.type, type),
        readablePlacementFilter(orgId),
      ),
    )
    .orderBy(...spaceListingOrder());
}

/** The `spaceIds` where every one of `packageIds` is placed, readable and active. */
export async function spacesActiveForAll(
  orgId: string,
  packageIds: readonly string[],
  spaceIds: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(packageIds)];
  if (!wanted.length || !spaceIds.length) return new Set();
  const query = db.select({ spaceId: spaces.id }).from(packages).$dynamic();
  const rows = await joinSpacePlacements(query, orgId, spaceIds)
    .where(
      and(inArray(packages.id, wanted), readablePlacementFilter(orgId), activeHereSql(spaces.id)),
    )
    .groupBy(spaces.id)
    .having(sql`count(*) = ${wanted.length}`);
  return new Set(rows.map((row) => row.spaceId));
}

/**
 * The spaces of {@link activeInSpaces} where a package is active: its home first
 * when it is one of them, then in the order of a space listing
 * ({@link spaceListingOrder}). Never empty: a package is listed for its spaces.
 */
export function activeSpaceIds() {
  return sql<
    string[]
  >`array_agg(${spaces.id} ORDER BY (${spaces.id} = ${packages.homeSpaceId}) IS TRUE DESC, ${sql.join(spaceListingOrder(), sql`, `)})`;
}

/**
 * ORDER BY for the TWO reads below — {@link listActivePackages}, which the
 * agent index and the served skills draw from, and `listActivePackageHints`,
 * the capped caller-context list: system first, then by id. One function so an index and
 * the hints the model is handed for it cannot rank the SAME active set
 * differently.
 *
 * The tie-break is load-bearing — Postgres does not order rows within an equal
 * sort key. It makes the cap stable, since which 15 of N survive is otherwise
 * undefined, and two identical get_me calls answer the same list.
 */
function packageListingOrder() {
  return [sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`, packages.id];
}

/**
 * List every package of one `type` any of `spaceIds` runs
 * ({@link activePackagesFilter}): what is switched on there (launchable once
 * its required integrations are active too), one row per package carrying the
 * spaces it is active in ({@link activeSpaceIds}) — ONE statement whatever the
 * number of spaces. Placed-but-off packages belong to
 * the library (`services/package-library.ts`). The projection omits
 * `draft_content`, which an index card never reads; `latestVersionId` answers
 * {@link isPublished}. Ordered by {@link packageListingOrder}.
 */
export async function listActivePackages(
  orgId: string,
  spaceIds: readonly string[],
  type: PackageType,
) {
  if (spaceIds.length === 0) return [];
  const query = db
    .select({
      id: packages.id,
      spaceIds: activeSpaceIds(),
      type: packages.type,
      draftManifest: packages.draftManifest,
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      latestVersionId: packageDistTags.versionId,
    })
    .from(packages)
    .leftJoin(packageDistTags, latestTagJoin(packages.id))
    .$dynamic();
  return activeInSpaces(query, orgId, spaceIds, type, [packageDistTags.versionId]).orderBy(
    ...packageListingOrder(),
  );
}

/** Active skill placements and their non-yanked latest archive in one statement.
 * Only shipped trees need the overlay here. An org draft is read under its draft lock.
 */
export async function listServedSkillPlacements(orgId: string, spaceIds: readonly string[]) {
  if (!spaceIds.length) return [];
  const query = db
    .select({
      id: packages.id,
      spaceIds: activeSpaceIds(),
      type: packages.type,
      source: packages.source,
      orgId: packages.orgId,
      draftManifest: sql<unknown>`CASE WHEN ${packages.source} = 'system' THEN ${packages.draftManifest} END`,
      draftContent: sql<
        string | null
      >`CASE WHEN ${packages.source} = 'system' THEN ${packages.draftContent} END`,
      latest: {
        version: packageVersions.version,
        integrity: packageVersions.integrity,
        yanked: packageVersions.yanked,
      },
    })
    .from(packages)
    .leftJoin(packageDistTags, latestTagJoin(packages.id))
    .leftJoin(packageVersions, eq(packageVersions.id, packageDistTags.versionId))
    .$dynamic();
  return activeInSpaces(query, orgId, spaceIds, "skill", [packageVersions.id]).orderBy(
    ...packageListingOrder(),
  );
}

export type ServedSkillPlacement = Awaited<ReturnType<typeof listServedSkillPlacements>>[number];

// ---------------------------------------------------------------------------
// Active-package hints — caller-context for the get_me payload
// ---------------------------------------------------------------------------

/**
 * Fields shared by every active-package hint (agents, skills, …). Per-type
 * extras (an agent's `takes_input`, a skill's `version`) are layered on top by
 * the projection passed to `listActivePackageHints`.
 */
interface PackageHint {
  /** Package identifier, e.g. "@appstrate/triage" / "@appstrate/web-research". */
  packageId: string;
  display_name: string;
  description: string;
  source: string;
  /**
   * True when the package has a published version (a `latest` dist-tag) or is a
   * system package. `false` means draft-only: omitting the version selector at
   * launch answers `404 no_published_version`.
   */
  published: boolean;
  /**
   * Whether THIS caller may write the package, i.e. whether the draft is theirs
   * to run (`version=draft`, `403 draft_not_writable` otherwise).
   *
   * It travels WITH `published` because the pair is one fact for a consumer:
   * `published: false, home_writable: false` is a package nobody but its author
   * can execute, and a caller context that says "draft only — run with
   * version=draft" to such a reader sends it into a 403 loop.
   */
  home_writable: boolean;
}

/** A `latest` dist-tag ({@link latestTagJoin}), or a system package — published by construction. */
export function isPublished(row: { source: string | null; latestVersionId: number | null }) {
  return row.source === "system" || row.latestVersionId != null;
}

const DEFAULT_PACKAGE_HINT_LIMIT = 15;

/**
 * Options every hint listing takes. `homeWritable` is a callback rather than a
 * context because the rule that answers it (`homeWireForCaller`) needs the Hono
 * request — the caller's role in the package's home space, its view-as persona,
 * its credential ceiling — which this service layer deliberately does not take.
 * It is pure and in-memory, so the row above already carries everything it
 * reads and the listing stays one query.
 */
interface HintOptions {
  limit?: number;
  homeWritable?: (pkg: {
    type: PackageType;
    source: string;
    homeSpaceId: string | null;
  }) => boolean;
}

/**
 * List the packages of one `type` an actor in this space could use, as a
 * bounded hint for the get_me caller context. "Could use" is
 * {@link activePackagesFilter}, the activation half of the run gate: a system
 * package, or a placement row that says `enabled`. The list is capped (`limit`) so a
 * large catalog doesn't bloat the payload — the long tail stays reachable
 * via `search`.
 *
 * Bounded IN SQL. One get_me call runs it twice (agents, then skills): the
 * activation filter and the LIMIT sit in the query, so only the
 * returned rows' manifests (`draft_manifest` JSONB) cross the wire, and
 * `total` rides along as a window count over the filtered set (evaluated
 * before the LIMIT, so it is the size of the whole catalog, not of the page).
 * The ordering is `packageListingOrder` — a total order, which is what
 * makes the cap deterministic.
 *
 * The base hint (id/name/description/source) is uniform across package types;
 * `project` layers on the type-specific extras from the manifest. Access gating
 * is NOT enforced here — the caller decides whether to surface the hint, and the
 * run / inline-run route re-validates at invoke time.
 */
async function listActivePackageHints<T extends PackageHint>(
  scope: SpaceScope,
  type: PackageType,
  project: (base: PackageHint, manifest: Record<string, unknown>) => T,
  opts?: HintOptions,
): Promise<{
  items: T[];
  /** Each item's row, same order: what {@link selectorlessLaunchManifests} reads. */
  rows: { source: string | null; draftManifest: unknown; latestVersionId: number | null }[];
  truncated: boolean;
  total: number;
}> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      draftManifest: packages.draftManifest,
      // `latest` dist-tag version id — non-null iff the package has a published
      // version. Lets `published` below be answered without an N+1 (a draft-only
      // agent must be run with `version=draft`).
      latestVersionId: packageDistTags.versionId,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageDistTags, latestTagJoin(packages.id))
    .where(activePackagesFilter(scope, type, scope.spaceId))
    .orderBy(...packageListingOrder())
    .limit(limit);

  const total = rows[0]?.total ?? 0;

  const items = rows.map((row) => {
    const manifest = asRecord(row.draftManifest) as Record<string, unknown>;
    const base: PackageHint = {
      packageId: typeof manifest.name === "string" ? manifest.name : row.id,
      display_name: typeof manifest.display_name === "string" ? manifest.display_name : "",
      description: typeof manifest.description === "string" ? manifest.description : "",
      source: row.source ?? "local",
      published: isPublished(row),
      // Decided by the CALLER's authority over the package's home, which this
      // service has no context to read — the route resolves it and hands the
      // verdict down. Absent resolver (no HTTP caller) ⇒ nobody authors here.
      home_writable: opts?.homeWritable?.(row) ?? false,
    };
    return project(base, manifest);
  });

  return { items, rows, truncated: total > items.length, total };
}

/** One entry in the active-agent hint exposed via get_me. */
interface ActiveAgentHint extends PackageHint {
  /** Whether the agent declares an input schema with at least one property. */
  takes_input: boolean;
  /** Required integrations not active here, in the selector-less launch's definition. */
  inactive_required_integrations: string[];
}

interface ActiveAgentHintsResult {
  agents: ActiveAgentHint[];
  /** True when the catalog was capped by `limit` (more reachable via search). */
  truncated: boolean;
  /** Total active agents before the cap. */
  total: number;
}

/**
 * The agents ACTIVE in the space, as a hint for the caller context. Active is not
 * launchable: `inactive_required_integrations` names what the run gate refuses
 * on, and connections are judged at launch only. The caller gates on the
 * `agents:run` permission and the run route re-checks RBAC at invoke time. See
 * {@link listActivePackageHints}.
 */
export async function listActiveAgentHints(
  scope: SpaceScope,
  opts?: HintOptions,
): Promise<ActiveAgentHintsResult> {
  const { items, rows, truncated, total } = await listActivePackageHints(
    scope,
    "agent",
    (base, manifest) => {
      const properties = asRecord(asRecord(asRecord(manifest.input).schema).properties);
      return { ...base, takes_input: Object.keys(properties).length > 0 };
    },
    opts,
  );
  const inactive = await inactiveRequiredIntegrationIds(
    await selectorlessLaunchManifests(rows),
    scope,
  );
  const agents = items.map((item, i) => ({
    ...item,
    inactive_required_integrations: inactive[i]!,
  }));
  return { agents, truncated, total };
}

/** One entry in the active-skill hint exposed via get_me. */
interface ActiveSkill extends PackageHint {
  /** The skill package's own manifest version, when known — pin a satisfiable
   * `dependencies.skills` range from it. */
  version: string | null;
}

interface ActiveSkillsResult {
  skills: ActiveSkill[];
  /** True when the catalog was capped by `limit` (more reachable via search). */
  truncated: boolean;
  /** Total active skills before the cap. */
  total: number;
}

/**
 * Active-skill hint for the caller context. Skills are not run directly: the
 * model declares them under an agent manifest's `dependencies.skills`, and the
 * inline-run preflight validates they exist at invoke time. The route gates it
 * on `skills:read`. See {@link listActivePackageHints}.
 */
export async function listActiveSkills(
  scope: SpaceScope,
  opts?: HintOptions,
): Promise<ActiveSkillsResult> {
  const { items, truncated, total } = await listActivePackageHints(
    scope,
    "skill",
    (base, manifest) => ({
      ...base,
      version: typeof manifest.version === "string" ? manifest.version : null,
    }),
    opts,
  );
  return { skills: items, truncated, total };
}

/** The run gate: is this package active in this space (RBAC spec §6.10)? The row wins, system packages included; with no row the deployment default decides. Carries the org boundary itself. */
export async function isPackageActiveHere(scope: SpaceScope, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .where(
      and(
        eq(packages.id, packageId),
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        activeHereSql(scope.spaceId),
      ),
    )
    .limit(1);

  return !!row;
}

// ---------------------------------------------------------------------------
// Space-package settings (per-space) — single source of truth for everything
// the `space_packages` row carries about one package: the agent's stored
// input values, their locks, and the model/proxy overrides.
// ---------------------------------------------------------------------------

/** Per-space settings for one package — the whole row, projected. */
export interface SpacePackageSettings {
  /**
   * Editor-set default values for the agent's input fields — layer 2 of the
   * input resolution (`services/input-resolution.ts`).
   */
  values: Record<string, unknown>;
  /** Input fields no caller may set at launch. */
  locked: string[];
  modelId: string | null;
  generationConfig: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
  proxyId: string | null;
}

/**
 * The `space_packages` row of `(space, package)` as settings, or defaults when
 * none exists. The org boundary is in the query, so another organization's row
 * yields defaults rather than its model and proxy override.
 */
export async function getSpacePackageSettings(
  scope: SpaceScope,
  packageId: string,
): Promise<SpacePackageSettings> {
  const [row] = await db
    .select({
      inputSettings: spacePackages.inputSettings,
      generationConfig: spacePackages.generationConfig,
      modelId: spacePackages.modelId,
      proxyId: spacePackages.proxyId,
    })
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
      ),
    )
    .limit(1);
  // JSONB read: narrow both members rather than trusting the column's
  // declared `$type`.
  const stored = row?.inputSettings;
  return {
    values: asRecord(stored?.values),
    locked: Array.isArray(stored?.locked) ? stored.locked : [],
    modelId: row?.modelId ?? null,
    generationConfig: row?.generationConfig ?? null,
    proxyId: row?.proxyId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resolved run-config — single source of truth for both the UI's per-space
// agent run and the CLI's `appstrate run @scope/agent` invocation. The
// CLI reads this endpoint after profile resolution to reproduce the UI
// run byte-for-byte (same model, proxy, generation settings) unless the user
// passed an explicit override flag. It carries no VERSION: which bytes run is
// the launch selector's business, not the placement's.
//
// Wire shape lives in `@appstrate/shared-types` so the CLI consumes the
// same interface without redeclaring it.
// ---------------------------------------------------------------------------

/**
 * Resolve the per-space run configuration for `(spaceId,
 * packageId)`. Returns `null` when the space holds no `space_packages` row it
 * may act on for the pair — the caller (route or CLI) decides whether that is
 * a 404 or a "no inheritance, fall back to flags + defaults" signal.
 *
 * The org filter lands in the SQL WHERE (`orgOrSystemFilter`) so a stray
 * association row pointing at another org's package id resolves to `null`
 * instead of leaking its model/proxy override.
 *
 * `input` republishes the row's stored input values and locks — layer 2 of
 * `services/input-resolution.ts`. The CLI needs them because `appstrate run
 * @scope/agent --local` executes the bundle on the caller's machine, where no
 * server-side resolution runs.
 */
export async function getResolvedRunConfig(
  scope: SpaceScope,
  packageId: string,
): Promise<ResolvedRunConfig | null> {
  const [row] = await db
    .select({
      inputSettings: spacePackages.inputSettings,
      generationConfig: spacePackages.generationConfig,
      modelId: spacePackages.modelId,
      proxyId: spacePackages.proxyId,
      draftManifest: packages.draftManifest,
    })
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
      ),
    )
    .limit(1);

  if (!row) return null;

  // JSONB read: narrow both members rather than trusting the column's
  // declared `$type` (same narrowing as `getSpacePackageSettings`).
  const stored = row.inputSettings;

  return {
    generation: row.generationConfig ?? null,
    modelId: row.modelId ?? null,
    proxyId: row.proxyId ?? null,
    input: {
      values: asRecord(stored?.values),
      locked_fields: Array.isArray(stored?.locked) ? stored.locked : [],
    },
  };
}

/**
 * Update the per-space settings row: model, proxy, generation settings and input
 * values. Never `enabled` (activation doors own it). The org check shares the
 * write's transaction.
 *
 *   - `requirePlacement: true`: a local row or an organization offer must already exist.
 *   - default: update the row; with none, create it only where the package is
 *     placed without one (home, system or organization offer), preserving the default activation.
 */
export async function updateSpacePackage(
  scope: SpaceScope,
  packageId: string,
  updates: {
    inputSettings?: { values: Record<string, unknown>; locked: string[] };
    modelId?: string | null;
    generationConfig?: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
    proxyId?: string | null;
  },
  /** `tx`: join the caller's transaction instead of opening one. */
  opts?: { requirePlacement?: boolean; tx?: Tx },
): Promise<void> {
  const set: Partial<{
    updatedAt: Date;
    inputSettings: { values: Record<string, unknown>; locked: string[] };
    modelId: string | null;
    generationConfig: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
    proxyId: string | null;
  }> = { updatedAt: new Date() };
  // The column's byte cap is enforced here, the one write path, not in a route schema.
  const inputSettings =
    updates.inputSettings === undefined
      ? undefined
      : parseBody(inputSettingsSchema, updates.inputSettings, "input_settings");
  if (inputSettings !== undefined) set.inputSettings = inputSettings;
  if (updates.modelId !== undefined) set.modelId = updates.modelId;
  if (updates.generationConfig !== undefined) set.generationConfig = updates.generationConfig;
  if (updates.proxyId !== undefined) set.proxyId = updates.proxyId;

  const work = async (tx: Tx) => {
    // `FOR SHARE`: the home read below decides whether a row may be created.
    const pkg = await loadPlaceablePackage(tx, scope, packageId);

    const existing = await currentPlacement(tx, packageId, scope.spaceId);
    if (existing) {
      await tx
        .update(spacePackages)
        .set(set)
        .where(
          and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)),
        );
      return;
    }
    // The public settings door accepts a local row or a current organization offer.
    if (opts?.requirePlacement ? !pkg.offeredToOrg : !placedWithoutRow(pkg, scope.spaceId)) {
      throw notFound(`Package '${packageId}' is not placed in this space`);
    }
    await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
        enabled: isActiveWithoutRow(pkg),
        placedByOffer: offerOnlyRow(pkg, scope.spaceId),
        ...(inputSettings !== undefined ? { inputSettings } : {}),
        ...(updates.modelId !== undefined ? { modelId: updates.modelId } : {}),
        ...(updates.generationConfig !== undefined
          ? { generationConfig: updates.generationConfig }
          : {}),
        ...(updates.proxyId !== undefined ? { proxyId: updates.proxyId } : {}),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [spacePackages.spaceId, spacePackages.packageId],
        set,
      });
  };
  return opts?.tx ? work(opts.tx) : db.transaction(work);
}

/** The active integrations an actor has no usable connection for, as a get_me hint. */
interface ConnectableIntegrationsResult {
  /** Their ids, in {@link packageListingOrder}. */
  integrations: string[];
  /** True when the list was capped by `limit`. */
  truncated: boolean;
  /** How many there are before the cap. */
  total: number;
}

/**
 * The integrations active in this space that declare an auth (a connection is what makes them
 * usable) and that none of `connected` names: what a connect flow would make usable here. Ids
 * only, capped like the other hints; a declared-auth-free integration needs no connection and is
 * never listed. The caller gates it on `integrations:read` and passes the integrations it found
 * a usable connection for (`listUsableIntegrationsForActor`).
 */
export async function listConnectableIntegrations(
  scope: SpaceScope,
  connected: ReadonlySet<string>,
  opts?: { limit?: number },
): Promise<ConnectableIntegrationsResult> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .where(activePackagesFilter(scope, "integration", scope.spaceId))
    .orderBy(...packageListingOrder());
  const ids = rows
    .filter((row) => Object.keys(asRecord(asRecord(row.draftManifest).auths)).length > 0)
    .map((row) => row.id)
    .filter((id) => !connected.has(id));
  return { integrations: ids.slice(0, limit), truncated: ids.length > limit, total: ids.length };
}
