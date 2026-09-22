// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level package management — activate, deactivate, list, and configure
 * packages within a space context.
 *
 * `space_packages` is the PLACEMENT's local instance: one row per (package,
 * space) carrying `enabled`, the model, the proxy and the stored input
 * settings. The three doors in this file are the only writers that CREATE one;
 * deactivating is not one of them, so deactivating and reactivating keeps every
 * setting the space chose.
 *
 * A row is deleted only when the placement behind it is withdrawn, by one of
 * two acts, each inside the transaction that withdraws it: `revokePackageShare`
 * (`services/package-shares.ts`) and the `keep: false` branch of
 * `reconcilePlacementsAfterRehome` (`services/package-placement.ts`) — plus the
 * cascades of the package's deletion and the space's.
 * `setBlockUserConnections` (`services/integration-pins-service.ts`) writes here
 * too, but only UPDATES a column in place on a row already placed.
 */

import { eq, and, exists, inArray, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spacePackages, packages, packageShares, packageDistTags } from "@appstrate/db/schema";
import { notFound, parseBody } from "../lib/errors.ts";
import { inputSettingsSchema } from "../lib/jsonb-schemas.ts";
import { orgOrSystemFilter, listedFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import { assertSpaceInScope } from "./spaces.ts";
import { ApiError } from "../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { parsePackageZip } from "@appstrate/core/zip";
import { placementReadFilter, placementRowJoin, placementShareJoin } from "./package-placement.ts";
import { getVersionForDownload } from "./package-versions.ts";
import { downloadVersionZip } from "./package-storage.ts";
import {
  activeHereSql,
  isActiveHere,
  isActiveWithoutRow,
  type ActivatablePackage,
} from "./package-activation.ts";

// ---------------------------------------------------------------------------
// Activate / Deactivate
// ---------------------------------------------------------------------------

/**
 * Historical mcp-server drafts may predate companion-file validation. Refuse
 * to activate one unless the exact `latest` archive is present and passes the
 * same parser used at authoring/import and runtime boot. System packages are
 * boot-registry artifacts and do not have a package_versions row here.
 *
 * Exported because {@link activatePackageWithin} cannot run it: it reads object
 * storage, which has no place inside a transaction. Every caller that opens its
 * own transaction around the activation — the home MOVE — runs this first, so
 * an unexecutable mcp-server fails the whole act with its 422 instead of
 * arriving switched on.
 *
 * The window between this check and the commit is ASSUMED: a republication
 * landing inside it swaps the archive this validated. The act gated here is an
 * activation, not an execution — the run path parses what it downloads — so the
 * worst outcome is a switch turned on for a bundle the next run refuses, which
 * the door would have reached one click later anyway. Closing the window would
 * mean holding object storage inside a database transaction.
 */
export async function assertMcpServerActivatable(
  scope: SpaceScope,
  packageId: string,
): Promise<void> {
  const [pkg] = await db
    .select({ type: packages.type, source: packages.source })
    .from(packages)
    .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
    .limit(1);
  if (!pkg || pkg.type !== "mcp-server" || pkg.source === "system") return;

  const version = await getVersionForDownload(packageId, "latest");
  if (!version) {
    throw new ApiError({
      status: 422,
      code: "bundle_invalid",
      title: "Invalid MCP Server Bundle",
      detail: `MCP-server package '${packageId}' has no activatable published version.`,
    });
  }

  try {
    const bytes = await downloadVersionZip(packageId, version.version, version.integrity);
    if (!bytes) throw new Error(`archive for ${packageId}@${version.version} is missing`);
    const parsed = parsePackageZip(new Uint8Array(bytes), { retiredRuntimeTools: "drop" });
    if (parsed.type !== "mcp-server" || parsed.packageId !== packageId) {
      throw new Error(
        `archive identity is ${parsed.packageId} (${parsed.type}), expected ${packageId} (mcp-server)`,
      );
    }
  } catch (err) {
    throw new ApiError({
      status: 422,
      code: "bundle_invalid",
      title: "Invalid MCP Server Bundle",
      detail: `MCP-server package '${packageId}@${version.version}' is not executable: ${getErrorMessage(err)}`,
    });
  }
}

/**
 * Is the package OFFERED to this space (`package_shares`)?
 *
 * `FOR UPDATE`, and that is the whole point of reading it here rather than in a
 * route. `revokePackageShare` deletes the offer and the placement row it backs
 * in one transaction; an activation that read the offer WITHOUT the lock could
 * commit its `space_packages` row after that DELETE had already scanned the
 * table, leaving a placement nothing authorizes. The lock serializes the two:
 * whichever starts second waits, and then sees the other's result — an
 * activation that got there first blocks the revoke until its row exists to be
 * deleted, and a revoke that got there first leaves this read finding nothing
 * (READ COMMITTED re-evaluates after the lock releases) so the activation
 * refuses.
 */
async function sharedWith(tx: Tx, packageId: string, spaceId: string): Promise<boolean> {
  const [row] = await tx
    .select({ packageId: packageShares.packageId })
    .from(packageShares)
    .where(and(eq(packageShares.packageId, packageId), eq(packageShares.spaceId, spaceId)))
    .limit(1)
    .for("update");
  return !!row;
}

/**
 * Is the package PLACED in this space? — the transactional reading of the rule
 * {@link placementReadFilter} states in SQL (`services/package-placement.ts`):
 * shipped with the deployment, homed here, or offered here. Nothing else, and
 * a `space_packages` row least of all — a row is a placement's consequence.
 *
 * BOTH doors need it, for the same two answers: whether the activation must
 * first write the offer (or refuse), and `wasActive` — the pre-write verdict
 * driving the status code and the audit, since an ORPHAN row is not "on"
 * anywhere ({@link isActiveHere}).
 *
 * The offer half goes through {@link sharedWith}, so it is read under the
 * `FOR UPDATE` lock the write path needs anyway: the answer has to still be
 * true when the transaction commits.
 */
async function placedHere(
  tx: Tx,
  pkg: { id: string; source: string | null; homeSpaceId: string | null },
  spaceId: string,
): Promise<boolean> {
  if (pkg.source === "system") return true;
  if (pkg.homeSpaceId === spaceId) return true;
  return sharedWith(tx, pkg.id, spaceId);
}

/**
 * The same question as {@link placedHere}, expressed as a WHERE clause an
 * UPDATE can carry — "this `space_packages` row is one the package is actually
 * PLACED in this space".
 *
 * Drizzle's `update` has no join, so the rule goes in as an `EXISTS` sub-select
 * instead of a `packageShares` LEFT JOIN — same rule, one statement, which is
 * what keeps a WRITE from deciding on a bare `(space_id, package_id)` pair
 * while every reader answers "absent".
 *
 * Conjoin it into ANY update of a `space_packages` row a caller can reach by
 * id, and treat "zero rows updated" as "not placed here". On an ORPHAN row the
 * UPDATE matches nothing, so the refusal is true rather than approximate.
 */
export function placedRowFilter(tx: DbOrTx, spaceId: string, packageId: string) {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(packages)
      .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
      .where(and(eq(packages.id, packageId), placementReadFilter(spaceId))),
  );
}

/**
 * Read the placement row of `(space, package)` inside a transaction.
 *
 * Both doors need it before they decide anything, and both need more than a
 * boolean: `activatePackage` reports whether it created the row and whether the
 * package was already active, and `deactivatePackage` tells "no row here yet"
 * from "a row that says false".
 *
 * `FOR UPDATE`, for the same reason {@link sharedWith} takes the lock on the
 * offer: `revokePackageShare` deletes the placement row and the offer behind it
 * in one transaction, and a bare SELECT here would let a reactivation decide on
 * a row that is being deleted — the `UPDATE … RETURNING` below would then match
 * nothing and the door would answer a placement that no longer exists. Under
 * the lock the revoke waits for us, or we wait for it and re-read (READ
 * COMMITTED) to find no row, which sends the call down the creation branch
 * where the offer is checked again and found gone.
 */
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
 * The catalog row both doors start from, or a 404 the caller cannot tell from
 * "no such package": the org-or-system predicate lands in the SQL WHERE, and an
 * ephemeral shadow row is never placeable.
 *
 * `FOR SHARE`, because `home_space_id` is read here and DECIDES whether the
 * placement needs an offer, while the home MOVE rewrites that column and
 * back-fills the offers the spaces losing the home now need. Unlocked, the two
 * interleave into a placement nothing places: this call reads `home = A` and
 * takes the "no offer required" branch, the move sets `home = B` and scans for
 * orphans without seeing our uncommitted row, and A keeps a `space_packages`
 * row with no offer behind it. A SHARE lock serializes the pair while leaving
 * concurrent activations in other spaces untouched.
 */
async function loadPlaceablePackage(tx: Tx, scope: SpaceScope, packageId: string) {
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
    .for("share");
  if (!pkg) throw notFound(`Package '${packageId}' not found in this organization`);
  return pkg;
}

/**
 * The placement as the wire names it, built from the rows the transaction just
 * wrote rather than re-read after it. A second SELECT would describe whatever
 * state the table is in when it lands, not the state this call produced — and
 * under concurrency that is a response describing somebody else's act.
 * Deliberately the same projection as {@link spacePackageSelect}, so the two
 * doors and the GET render one shape.
 */
function spacePackageWire(
  row: typeof spacePackages.$inferSelect,
  pkg: { type: string; source: string | null; draftManifest: unknown },
) {
  return {
    packageId: row.packageId,
    generationConfig: row.generationConfig,
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
  /** Whether THIS call created the offer that places the package here. */
  shared: boolean;
  /** Whether the package was ALREADY active here when the call arrived. */
  wasActive: boolean;
}

/**
 * Activate a package in a space — the ONE door, for a personal space and a team
 * space alike (RBAC spec §6.10), and an UPSERT rather than a create: the
 * placement row carries the space's model, proxy and stored input settings, so
 * putting a package down and picking it up again must not cost them. A second
 * activation of an active package is a no-op answering with the same body, not
 * a 409 — asking for a state the system is already in is not an error.
 *
 * CREATING the row is the part the PLACEMENT rule gates: the package must be
 * HOMED here or SHARED here, read under the row lock of the transaction that
 * acts on it (see {@link sharedWith}). So the placement exists first, or is
 * CREATED by this call — that is what `shareBy` is for. Flipping an EXISTING
 * row back on asks nothing more, since a revoke takes row and offer together.
 *
 * `shareBy` is the caller's id and means "write the offer in with the
 * placement". The route checks that authority (`assertPackageShareAccess`)
 * beforehand; here it only means the two rows land in ONE transaction, so a
 * placement can never exist without the offer that authorizes it. A missing
 * placement WITHOUT `shareBy` is a 404, never a 403: the package id may be
 * private, and a named refusal would confirm it exists.
 *
 * Writes neither initial values nor a version. `input_settings` has exactly one
 * write path (`PUT /api/agents/{scope}/{name}/input-settings`), and outside its
 * home a package runs the `latest` published version, always.
 *
 * Both returned flags answer for what this call DID, so the route's audits
 * cannot claim an act that did not happen: `shared` is set only when the
 * `onConflictDoNothing` insert created the offer, and `wasActive` is
 * {@link isActiveHere} evaluated BEFORE the write — so a package the deployment
 * already switches on with no row answers 200 and records nothing.
 */
export async function activatePackage(
  scope: SpaceScope,
  packageId: string,
  opts?: { shareBy?: string },
): Promise<PackageActivation> {
  await assertSpaceInScope(scope);
  await assertMcpServerActivatable(scope, packageId);

  // The org-visibility check and the write run in ONE transaction so the tenant
  // boundary is atomic with it — a separate preflight would leave a window
  // where a `space_packages` row could be grafted onto a package the org
  // cannot see.
  return db.transaction((tx) => activatePackageWithin(tx, scope, packageId, opts));
}

/**
 * {@link activatePackage}'s body, inside a transaction the CALLER owns — the
 * seam that keeps `space_packages` to a single writer.
 *
 * The home MOVE (`PUT /api/packages/{scope}/{name}/home`) has to place the package
 * in its new home atomically with the move itself, and an activation that
 * opened a transaction of its own would break that atomicity. It therefore
 * calls this directly, having run {@link assertSpaceInScope} and
 * {@link assertMcpServerActivatable} first — neither belongs inside a
 * transaction (the second reads object storage), and both must still refuse the
 * act rather than let it half-happen.
 *
 * `keepExistingDecision` is the move's other need: a destination that had
 * deliberately switched the package OFF keeps that decision, because moving the
 * home transfers AUTHORITY over a package, not a verdict about what any space
 * runs. Absent the flag — the HTTP door — an existing row is switched back on,
 * which is the whole point of that door.
 */
export async function activatePackageWithin(
  tx: Tx,
  scope: SpaceScope,
  packageId: string,
  opts?: { shareBy?: string; keepExistingDecision?: boolean },
): Promise<PackageActivation> {
  const pkg = await loadPlaceablePackage(tx, scope, packageId);
  // The placement question, asked ONCE for both branches and BEFORE anything
  // is written — the offer this call may be about to create does not count.
  //
  // It comes BEFORE `currentPlacement`, and the ORDER is the contract: this
  // takes `package_shares` and that takes `space_packages`, while
  // `revokePackageShare` deletes the two in that same order (offer, then the
  // placement it backs). Two transactions taking the same pair of row locks in
  // OPPOSITE orders is a deadlock — one waits on the offer while holding the
  // row, the other waits on the row while holding the offer, and PostgreSQL
  // aborts one with `40P01`. Every path that touches both tables takes the
  // OFFER first.
  const placedBefore = await placedHere(tx, pkg, scope.spaceId);
  const existing = await currentPlacement(tx, packageId, scope.spaceId);
  // THE rule, read before the write: the row if there is one AND the package
  // is placed here, the deployment's default otherwise
  // (`services/package-activation.ts`).
  const wasActive = isActiveHere(pkg, existing, placedBefore);

  // A SYSTEM package is readable in every space of every organization and
  // takes no share — the placement rule has nothing to say about it, here as
  // in `placementGrantsRead`. Everything else must be placed BEFORE its row
  // means anything, an existing row included: a row with no placement behind
  // it is the orphan `scripts/migration/0016` repairs, and switching it on
  // would be writing `enabled = true` onto a state no page shows and no door
  // honours. With `shareBy` this call writes the offer that places it — which
  // is also how the recipient of an offer activates it in the first place.
  let shared = false;
  if (!placedBefore) {
    if (opts?.shareBy === undefined) {
      throw notFound(`Package '${packageId}' not found in this organization`);
    }
    const offer = await tx
      .insert(packageShares)
      .values({ packageId, spaceId: scope.spaceId, sharedBy: opts.shareBy })
      .onConflictDoNothing()
      .returning({ packageId: packageShares.packageId });
    shared = offer.length > 0;
  }

  if (existing) {
    if (opts?.keepExistingDecision) {
      return {
        placement: spacePackageWire(existing, pkg),
        created: false,
        shared,
        wasActive,
      };
    }
    const [row] = await tx
      .update(spacePackages)
      .set({ enabled: true, updatedAt: new Date() })
      .where(and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)))
      .returning();
    // `currentPlacement` held the row under `FOR UPDATE`, so this matches. An
    // empty result would mean the row vanished under the lock — impossible, and
    // a non-null assertion here would turn that impossibility into a response
    // describing a placement that does not exist.
    if (!row) throw notFound(`Package '${packageId}' is not placed in this space`);
    return { placement: spacePackageWire(row, pkg), created: false, shared, wasActive };
  }

  // `onConflictDoUpdate` rather than a bare INSERT: nothing locks a row that
  // does not exist yet, so two first activations racing each other both read no
  // placement, and the loser would take a unique-constraint 500 on an act R16
  // makes idempotent. The cost is that `created` is decided by the read above
  // and can be true on both sides of that race — one duplicate audit entry at
  // worst, where the alternative is a 500 on a button press.
  const [row] = await tx
    .insert(spacePackages)
    .values({ spaceId: scope.spaceId, packageId })
    .onConflictDoUpdate({
      target: [spacePackages.spaceId, spacePackages.packageId],
      set: opts?.keepExistingDecision
        ? { updatedAt: new Date() }
        : { enabled: true, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw notFound(`Package '${packageId}' is not placed in this space`);

  return { placement: spacePackageWire(row, pkg), created: true, shared, wasActive };
}

/**
 * "There is NO row here — is the package on anyway?" — the ONE reading of the
 * deployment's default in this file, and the refusal both doors that would
 * WRITE a first row share.
 *
 * Two callers: {@link deactivatePackage}, which materializes the sticky opt-out
 * only for a package the default switches on, and
 * {@link updateSpacePackage}'s create-on-first-write, which must not turn
 * configuring into activating. The rule is not re-derived here —
 * {@link isActiveWithoutRow} IS the deployment default; this only decides what
 * the refusal looks like.
 */
function assertActiveWithoutRow(pkg: ActivatablePackage, packageId: string): void {
  if (!isActiveWithoutRow(pkg)) {
    throw notFound(`Package '${packageId}' is not active in this space`);
  }
}

/**
 * Deactivate a package in a space — `enabled = false`, the row and every
 * setting on it left exactly where they are.
 *
 * The row is NOT deleted, and that is the whole point: it holds the space's
 * model, proxy, generation settings and stored input values, so "switch it off
 * for a week" must not cost the configuration. Only `revokePackageShare`
 * removes it, along with the placement itself.
 *
 * Three answers, following from the activation rule, not from the type:
 *
 *   - a row is here → set it to `false`;
 *   - NO row and the package is ON by the deployment's default (a system
 *     package, an integration `SYSTEM_INTEGRATIONS` names) → materialize the row
 *     that says `false`. The sticky opt-out: only an explicit row outvotes the
 *     default, run after run;
 *   - NO row and the package is not on → 404. An offer nobody has taken up is
 *     not "on", and writing a row would turn the library's pending offer into
 *     "switched off" — a decision the recipient never made.
 *
 * `changed` says whether the space's answer actually moved, so the route can
 * keep `package.deactivated` symmetric with `package.activated` and write only
 * for an act that happened.
 */
export async function deactivatePackage(
  scope: SpaceScope,
  packageId: string,
): Promise<{ changed: boolean }> {
  await assertSpaceInScope(scope);

  return db.transaction(async (tx) => {
    const pkg = await loadPlaceablePackage(tx, scope, packageId);
    // Offer BEFORE placement row, the lock order every path that touches both
    // tables takes — see `activatePackageWithin`.
    const placed = await placedHere(tx, pkg, scope.spaceId);
    const existing = await currentPlacement(tx, packageId, scope.spaceId);
    // Same pre-write verdict the activation door reads, for the same reason:
    // `changed` drives the `package.deactivated` audit, and an ORPHAN row was
    // never running anything to switch off.
    const wasActive = isActiveHere(pkg, existing, placed);

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

    // No row: only the deployment default can have switched this on, and only
    // an explicit row can outvote it.
    assertActiveWithoutRow(pkg, packageId);

    await tx
      .insert(spacePackages)
      .values({ spaceId: scope.spaceId, packageId, enabled: false })
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

// Stored input values (`space_packages.input_settings`) are deliberately
// NOT projected here: this listing is the activation surface, and the agent's
// stored values are read through `GET /api/agents/{scope}/{name}` where they
// travel with the schema and the locks that give them meaning
// (`AgentDetail.input`).
const spacePackageSelect = {
  packageId: spacePackages.packageId,
  generationConfig: spacePackages.generationConfig,
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
  // Two filters, two different leaks — the projection carries `draft_manifest`
  // either way. `orgOrSystemFilter`: a stray row pointing at another org's
  // package must not surface that package. `placementReadFilter`: a row is not
  // a placement, so an ORPHAN row must not surface a draft this space has lost.
  const conditions = [
    eq(spacePackages.spaceId, scope.spaceId),
    orgOrSystemFilter(scope.orgId),
    placementReadFilter(scope.spaceId),
  ];
  if (type) {
    conditions.push(eq(packages.type, type));
  }

  return db
    .select(spacePackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .leftJoin(packageShares, placementShareJoin(spacePackages.packageId, scope.spaceId))
    .where(and(...conditions));
}

export async function getSpacePackage(scope: SpaceScope, packageId: string) {
  // Both filters land in the SQL WHERE so this is never an existence oracle:
  // a row pointing at another org's package resolves to `null`, and so does an
  // orphan row — exactly like a package that does not exist. See
  // `listSpacePackages` above.
  const [row] = await db
    .select(spacePackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .leftJoin(packageShares, placementShareJoin(spacePackages.packageId, scope.spaceId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
        placementReadFilter(scope.spaceId),
      ),
    )
    .limit(1);

  return row ?? null;
}

// ---------------------------------------------------------------------------
// Active packages in a space (single query)
// ---------------------------------------------------------------------------

/**
 * WHERE for "ACTIVE in this space, of this `type`" — org-or-system owned,
 * never an ephemeral shadow. Expects BOTH of {@link activeHereSql}'s joins,
 * `spacePackages` and `packageShares`, each on (package, this space).
 *
 * The predicate is {@link activeHereSql}, shared with
 * {@link isPackageActiveHere}, with the library's projection and with the index
 * listings, so what an index page shows, what the caller-context hints tell the
 * model it may invoke, and what the run gate lets through are one set.
 *
 * The two LISTINGS below conjoin `listedFilter` on top of it and the run gate
 * does not: an unlisted package is off the catalogue and still runs. That is
 * the one direction the sets may differ in — a listing may drop a row, never
 * add one — so no page can offer what a run would refuse.
 */
function activePackagesFilter(scope: SpaceScope, type: PackageType) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    activeHereSql(scope.spaceId),
  );
}

/**
 * ORDER BY for the TWO reads below — {@link listActivePackages}, which the
 * per-type index pages draw from, and `listActivePackageHints`, the capped
 * caller-context list: system first, then by id. One function so an index and
 * the hints the model is handed for it cannot rank the SAME active set
 * differently.
 *
 * The tie-break is load-bearing — Postgres does not order rows within an equal
 * sort key. The chat renders the hint list into its system prompt, which pi-ai
 * emits as ONE cache block with ONE breakpoint, so a reshuffle invalidates the
 * cached prefix and the history behind it; and it makes the cap stable, since
 * which 15 of N survive is otherwise undefined.
 */
function packageListingOrder() {
  return [sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`, packages.id];
}

/**
 * List every package of one `type` this space RUNS — {@link
 * activePackagesFilter}, so `GET /api/agents` is the agents index page in the
 * sense every other index page has: what can be launched from here.
 *
 * A package merely PLACED here — a pending offer, or one switched off — is not
 * on it. That state is the space library's subject
 * (`GET /api/spaces/{id}/library`, `services/package-library.ts`), which names
 * each placement's origin and state and carries the switch. The detail page
 * stays open either way — an author edits an agent nobody runs.
 *
 * Single query via LEFT JOIN — no N+1.
 *
 * The projection is what an INDEX draws a card from, and nothing else.
 * `draft_content` in particular — the whole `prompt.md` / `SKILL.md` body, by
 * far the largest column on the row (`services/package-items/crud.ts` says the
 * same where it omits it) — is not on it: the one caller's mapper never read it,
 * so every load of `GET /api/agents` was shipping K prompts out of Postgres to
 * drop them. Neither is the `latest` dist-tag: no reader of this listing asks
 * whether the package is published, which is why the join that produced it is
 * gone too. The hints listing below keeps both the join and the column because
 * its own `published` field reads them.
 */
export async function listActivePackages(scope: SpaceScope, type: PackageType) {
  return db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
      source: packages.source,
    })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .where(and(activePackagesFilter(scope, type), listedFilter()))
    .orderBy(...packageListingOrder());
}

// ---------------------------------------------------------------------------
// Active-package hints — caller-context for the chat / get_me payload
// ---------------------------------------------------------------------------

/**
 * Fields shared by every active-package hint (agents, skills, …). Per-type
 * extras (an agent's `takes_input`, a skill's `version`) are layered on top by
 * the projection passed to `listActivePackageHints`.
 */
interface PackageHint {
  /** Package identifier, e.g. "@appstrate/triage" / "@appstrate/web-research". */
  package_id: string;
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
 * bounded hint for the get_me / chat-prompt caller context. "Could use" is
 * {@link activePackagesFilter}, the run gate's own predicate: a system package,
 * or a placement row that says `enabled`. The list is capped (`limit`) so a
 * large catalog doesn't bloat the system prompt — the long tail stays reachable
 * via `search_operations`.
 *
 * Bounded IN SQL. This runs twice per chat turn (agents, then skills) on the
 * TTFT path: the activation filter and the LIMIT sit in the query, so only the
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
/**
 * Columns every hint read projects from. Shared so the capped LISTING and the
 * exact-id resolution below cannot select different halves of the same row and
 * hand the model two different descriptions of one package.
 */
const hintColumns = {
  id: packages.id,
  type: packages.type,
  source: packages.source,
  homeSpaceId: packages.homeSpaceId,
  draftManifest: packages.draftManifest,
  // `latest` dist-tag version id — non-null iff the package has a published
  // version. Lets `published` below be answered without an N+1 (a draft-only
  // agent must be run with `version=draft`).
  latestVersionId: packageDistTags.versionId,
} as const;

/** One row as {@link hintColumns} selects it. */
type HintRow = {
  id: string;
  type: PackageType;
  source: string;
  homeSpaceId: string | null;
  draftManifest: unknown;
  latestVersionId: number | null;
};

/**
 * Row → hint, the ONE projection both hint reads use. It is where
 * `package_id` / `published` / `home_writable` are decided, so extracting it
 * is what keeps the capped listing and the exact-id resolution honest about
 * the same row.
 */
function projectPackageHint<T extends PackageHint>(
  row: HintRow,
  project: (base: PackageHint, manifest: Record<string, unknown>) => T,
  homeWritable: HintOptions["homeWritable"],
): T {
  const manifest = asRecord(row.draftManifest) as Record<string, unknown>;
  const base: PackageHint = {
    package_id: typeof manifest.name === "string" ? manifest.name : row.id,
    display_name: typeof manifest.display_name === "string" ? manifest.display_name : "",
    description: typeof manifest.description === "string" ? manifest.description : "",
    source: row.source ?? "local",
    published: row.source === "system" || row.latestVersionId != null,
    // Decided by the CALLER's authority over the package's home, which this
    // service has no context to read — the route resolves it and hands the
    // verdict down. Absent resolver (no HTTP caller) ⇒ nobody authors here.
    home_writable: homeWritable?.(row) ?? false,
  };
  return project(base, manifest);
}

/**
 * Join condition for the `latest` dist-tag row {@link hintColumns} reads
 * `latestVersionId` from. Named so both hint reads join it identically.
 */
function latestDistTagJoin() {
  return and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest"));
}

async function listActivePackageHints<T extends PackageHint>(
  scope: SpaceScope,
  type: PackageType,
  project: (base: PackageHint, manifest: Record<string, unknown>) => T,
  opts?: HintOptions,
): Promise<{ items: T[]; truncated: boolean; total: number }> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await db
    .select({ ...hintColumns, total: sql<number>`count(*) over ()`.mapWith(Number) })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .leftJoin(packageDistTags, latestDistTagJoin())
    .where(and(activePackagesFilter(scope, type), listedFilter()))
    .orderBy(...packageListingOrder())
    .limit(limit);

  const total = rows[0]?.total ?? 0;

  const items = rows.map((row) => projectPackageHint(row, project, opts?.homeWritable));

  return { items, truncated: total > items.length, total };
}

/** One entry in the runnable-agent hint exposed via get_me / the chat prompt. */
interface RunnableAgent extends PackageHint {
  /** Whether the agent declares an input schema with at least one property. */
  takes_input: boolean;
}

interface RunnableAgentsResult {
  agents: RunnableAgent[];
  /** True when the catalog was capped by `limit` (more reachable via search). */
  truncated: boolean;
  /** Total runnable agents before the cap. */
  total: number;
}

/**
 * Runnable-agent hint for the caller context. "Runnable" is a hint only — the
 * caller gates on the `agents:run` permission and the run route re-checks RBAC
 * at invoke time. See {@link listActivePackageHints}.
 */
export async function listRunnableAgents(
  scope: SpaceScope,
  opts?: HintOptions,
): Promise<RunnableAgentsResult> {
  const { items, truncated, total } = await listActivePackageHints(
    scope,
    "agent",
    (base, manifest) => {
      const properties = asRecord(asRecord(asRecord(manifest.input).schema).properties);
      return { ...base, takes_input: Object.keys(properties).length > 0 };
    },
    opts,
  );
  return { agents: items, truncated, total };
}

/** One entry in the active-skill hint exposed via get_me / the chat prompt. */
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

/** The skill-specific half of the hint projection, shared by both reads below. */
function projectActiveSkill(base: PackageHint, manifest: Record<string, unknown>): ActiveSkill {
  return { ...base, version: typeof manifest.version === "string" ? manifest.version : null };
}

/**
 * Active-skill hint for the caller context. Skills are not run directly: the
 * model declares them under an agent manifest's `dependencies.skills`, and the
 * inline-run preflight validates they exist at invoke time. Same `agents:run`
 * caller gate as agents. See {@link listActivePackageHints}.
 */
export async function listActiveSkills(
  scope: SpaceScope,
  opts?: HintOptions,
): Promise<ActiveSkillsResult> {
  const { items, truncated, total } = await listActivePackageHints(
    scope,
    "skill",
    projectActiveSkill,
    opts,
  );
  return { skills: items, truncated, total };
}

/**
 * Resolve named skills by EXACT id for this space — the chat's index read,
 * where the caller already knows which skills it wants (platform defaults, a
 * session's pins) rather than browsing a catalogue.
 *
 * Deliberately WITHOUT {@link listedFilter}. Visibility is discoverability, not
 * authorization: an `unlisted` skill is off every catalogue and stays fully
 * resolvable by exact id, which is the entire point of the marker — the chat's
 * platform defaults ship unlisted precisely so they serve the assistant without
 * cluttering the user's skill catalogue. Everything else holds:
 * {@link activePackagesFilter} is the same org/placement/activation gate the run
 * path uses, and the caller re-checks `skills:read` before asking at all.
 *
 * One query, `ORDER BY package_id` so the rendered index is byte-stable across
 * turns (the chat's system prompt is a single prompt-cache block). `unresolved`
 * carries the ids no row answered, in REQUEST order — an unknown id is data for
 * the caller to report, never an error.
 */
export async function resolveSkillsByIds(
  scope: SpaceScope,
  ids: readonly string[],
  opts?: HintOptions,
): Promise<{ resolved: ActiveSkill[]; unresolved: string[] }> {
  if (ids.length === 0) return { resolved: [], unresolved: [] };
  const rows = await db
    .select(hintColumns)
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .leftJoin(packageDistTags, latestDistTagJoin())
    .where(and(activePackagesFilter(scope, "skill"), inArray(packages.id, [...ids])))
    .orderBy(packages.id);

  const found = new Set(rows.map((row) => row.id));
  return {
    resolved: rows.map((row) => projectPackageHint(row, projectActiveSkill, opts?.homeWritable)),
    unresolved: ids.filter((id) => !found.has(id)),
  };
}

/**
 * The RUN gate: is this package ACTIVE in this space?
 *
 * Deactivated means it does not execute (RBAC spec §6.10) — the switch the
 * space threw is the whole answer, and it is the same one the library renders
 * and the hints obey ({@link activeHereSql}). The row always wins where the
 * package is PLACED, a system package included: a space that switched one off
 * runs it nowhere. With no row the deployment's default decides. Placement
 * alone grants nothing either — a package homed here and never switched on
 * runs nowhere.
 *
 * The org boundary is IN this query (`orgOrSystemFilter`) rather than left to
 * each caller's next read: a boundary held by convention is one an added
 * caller drops silently, and the cost of stating it here is a predicate on an
 * indexed column.
 */
export async function isPackageActiveHere(scope: SpaceScope, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
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
 * The `space_packages` row of `(space, package)` as SETTINGS, or the defaults
 * when this space holds no row it may act on.
 *
 * Carries the tenant boundary and the placement rule IN this query, like every
 * other reader of the table ({@link isPackageActiveHere},
 * {@link getResolvedRunConfig}): `orgOrSystemFilter` so a row pointing at
 * another organization's package resolves to defaults instead of handing back
 * its model and proxy override, and {@link placementReadFilter} so an ORPHAN row
 * reads as no row at all. A dozen call sites reach this — the run doors, the
 * scheduler tick, the schedule routes, the agent model/proxy pair, the detail —
 * and a boundary held by convention is one the next of them drops in silence.
 * The joins the rule needs are part of this query, not the caller's.
 *
 * "No row it may act on" and "a row holding nothing" are deliberately the same
 * answer — the defaults below — since no caller could use the distinction.
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
    .leftJoin(packageShares, placementShareJoin(spacePackages.packageId, scope.spaceId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
        placementReadFilter(scope.spaceId),
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
 * instead of leaking its model/proxy override, and `placementReadFilter`
 * closes the same shape within the org: an ORPHAN row carries the model and
 * the display name of a package this space no longer holds, so it reads as no
 * row at all.
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
    .leftJoin(packageShares, placementShareJoin(spacePackages.packageId, scope.spaceId))
    .where(
      and(
        eq(spacePackages.spaceId, scope.spaceId),
        eq(spacePackages.packageId, packageId),
        orgOrSystemFilter(scope.orgId),
        placementReadFilter(scope.spaceId),
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
 * Update the per-space settings row for `(spaceId, packageId)` — the model, the
 * proxy, the generation settings and the stored input values, and nothing else.
 *
 * `enabled` is NOT here: activation has its own pair of doors
 * ({@link activatePackage} / {@link deactivatePackage}), which keeps the
 * placement rule, the offer it may create and the audit in one place.
 *
 * The org-visibility check runs in the SAME transaction as the write, so the
 * write can never graft a row onto a package id the org cannot see.
 *
 * Two modes:
 *   - `requirePlacement: true` (the public
 *     `PUT /spaces/:id/packages/:packageId` route): the placement row MUST
 *     already exist AND the package must be PLACED here
 *     ({@link placedRowFilter}) — creating a row, or acting on an orphan one,
 *     is a 404, never an implicit activation.
 *   - default (the agent input-settings / proxy / model routes): upsert, but
 *     ONLY where creating the row states no new decision. A system agent the
 *     deployment switches on has no row until its first per-space setting, and
 *     the row it gains says `enabled = true`, which it already was. A package
 *     NOT on and with no row — a pending offer — is refused, since writing the
 *     row there would ACTIVATE it. Those routes preflight via `requireAgent()`,
 *     which asks PLACEMENT only; the in-transaction checks below re-enforce
 *     both boundaries atomically.
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
  opts?: { requirePlacement?: boolean },
): Promise<void> {
  const set: Partial<{
    updatedAt: Date;
    inputSettings: { values: Record<string, unknown>; locked: string[] };
    modelId: string | null;
    generationConfig: import("@appstrate/core/model-generation").ModelGenerationSettings | null;
    proxyId: string | null;
  }> = { updatedAt: new Date() };
  // `space_packages.input_settings` has exactly ONE write path, and it is
  // this function — the public input-settings route and every internal caller
  // both land here. The column's byte cap therefore belongs on THIS side of the
  // call rather than in the route body schema, which an internal caller would
  // simply walk past. `parseBody` renders a cap violation as the same RFC-9457
  // 400 the route would have produced (`errors[0].field === "input_settings"`).
  const inputSettings =
    updates.inputSettings === undefined
      ? undefined
      : parseBody(inputSettingsSchema, updates.inputSettings, "input_settings");
  if (inputSettings !== undefined) set.inputSettings = inputSettings;
  if (updates.modelId !== undefined) set.modelId = updates.modelId;
  if (updates.generationConfig !== undefined) set.generationConfig = updates.generationConfig;
  if (updates.proxyId !== undefined) set.proxyId = updates.proxyId;

  await db.transaction(async (tx) => {
    // Tenant boundary, atomic with the write: the target package must be
    // visible to the org (own or system) and not an ephemeral shadow row.
    const [pkg] = await tx
      .select({ id: packages.id, type: packages.type, source: packages.source })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
      .limit(1);
    if (!pkg) {
      throw notFound(`Package '${packageId}' not found in this organization`);
    }

    if (opts?.requirePlacement) {
      // PLACED here, not merely "there is a row": the pair alone matches an
      // ORPHAN (`scripts/migration/0016`), and this route's own follow-up read
      // (`getSpacePackage`, placement-joined) then finds nothing — the write
      // landed and the 200 body was `{"object":"space_package"}`. The
      // `EXISTS` makes the UPDATE match nothing instead, so the refusal below
      // states the truth.
      const updated = await tx
        .update(spacePackages)
        .set(set)
        .where(
          and(
            eq(spacePackages.spaceId, scope.spaceId),
            eq(spacePackages.packageId, packageId),
            placedRowFilter(tx, scope.spaceId, packageId),
          ),
        )
        .returning({ packageId: spacePackages.packageId });
      if (updated.length === 0) {
        throw notFound(`Package '${packageId}' is not placed in this space`);
      }
      return;
    }

    // Create-on-first-write, and only where it changes no verdict. Without this
    // guard, configuring a package that is merely OFFERED here would create its
    // placement row, and a row means active — a silent activation through a
    // door that asks neither the placement rule nor `<type>:share`, and writes
    // no `package.activated`. Same refusal, from the same function, as
    // {@link deactivatePackage}'s third branch.
    const existing = await currentPlacement(tx, packageId, scope.spaceId);
    if (!existing) assertActiveWithoutRow(pkg, packageId);

    await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
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
  });
}
