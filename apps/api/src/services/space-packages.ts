// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level package management — activate, deactivate, list, and configure
 * packages within a space context.
 *
 * `space_packages` is the PLACEMENT's local instance: one row per (package,
 * space) carrying `enabled`, the model, the proxy and the stored input
 * settings. It is created by the first activation and never deleted again
 * except by the revoke of the share that placed it, by the package's deletion
 * or by the space's — so deactivating and reactivating keeps every setting the
 * space chose.
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { spacePackages, packages, packageShares, packageDistTags } from "@appstrate/db/schema";
import { notFound, parseBody } from "../lib/errors.ts";
import { inputSettingsSchema } from "../lib/jsonb-schemas.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import { assertSpaceInScope } from "./spaces.ts";
import { ApiError } from "../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { parsePackageZip } from "@appstrate/core/zip";
import { placementReadFilter } from "./package-placement.ts";
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
 * It therefore runs BEFORE the transaction, on both callers, and the window
 * between this check and the commit is assumed: a republication landing inside
 * it swaps the `latest` archive this validated for another. The act being
 * gated is an ACTIVATION, not an execution — the run path parses the archive
 * it actually downloads — so the worst outcome is a switch turned on for a
 * bundle that the next run refuses, which is the state the door would have
 * reached one click later anyway. Closing the window would mean holding object
 * storage inside a database transaction, which is the trade this refuses.
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

/** Transaction-local reads the placement rule needs. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
 * BOTH doors need it, and for the same two answers. It decides whether the
 * activation must first write the offer (or refuse), and it decides
 * `wasActive` — the pre-write verdict that drives the status code and the
 * audit — because an ORPHAN row is not "on" anywhere ({@link isActiveHere}).
 * Reading it once, here, is what keeps those two from drifting into different
 * ideas of what "placed" means.
 *
 * The offer half goes through {@link sharedWith}, so it is read under the
 * `FOR UPDATE` lock the write path needs anyway: the answer this returns has
 * to still be true when the transaction commits.
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
 * placement needs an offer. The home MOVE (`PATCH /api/packages/{scope}/{name}`)
 * rewrites that column in a transaction of its own and, in the same one,
 * back-fills the offers the spaces losing the home now need. Unlocked, the two
 * interleave into a placement nothing places: this call reads `home = A`, takes
 * the "no offer required" branch, the move sets `home = B` and scans for
 * orphaned placements without seeing our uncommitted row, and A ends up with a
 * `space_packages` row, no `package_shares` row, a package invisible on every
 * page and still runnable by a schedule — exactly the state
 * `scripts/migration/0016` exists to repair. A SHARE lock serializes the pair
 * while leaving concurrent activations in different spaces untouched; the move
 * holds the row's write lock, so whichever arrives second re-reads the home it
 * will actually be judged against.
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
  if (!pkg) throw notFound(`Package '${packageId}' not found in organization catalog`);
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
 * acts on it (see {@link sharedWith}). An activation is deliberately NOT a
 * placement of its own — that would be the one way into a space that never
 * consults `<type>:share`, letting a builder of B pull in A's package while A
 * decided nothing. The placement exists first, or is CREATED by this call,
 * which is what `shareBy` is for. Flipping an EXISTING row back on asks nothing
 * more: that row is only there because a placement put it there, and a revoke
 * takes both away in one transaction.
 *
 * `shareBy` is the caller's id and says "I hold `share` in this package's home,
 * so put the offer in with the placement". The route checks that authority
 * (`assertPackageShareAccess`) before handing it over; here it only means the
 * share row is written in the SAME transaction as the `space_packages` row, so
 * a placement can never exist without the offer that authorizes it.
 *
 * A missing placement without `shareBy` is a 404, never a 403: the package id
 * may be private, and a named refusal would confirm it exists.
 *
 * Deliberately takes no initial values: `space_packages.input_settings` holds
 * the agent's editor-set input defaults, and it has exactly ONE write path —
 * `PUT /api/agents/{scope}/{name}/input-settings`, which validates them against
 * `manifest.input.schema` and refuses a locked required field with no value
 * behind it. A first activation writes the column's empty default and nothing
 * else.
 *
 * It writes NO version either. Outside its home a package runs the `latest`
 * published version, always; the draft belongs to whoever can write it.
 *
 * `shared` says whether THIS call created the offer. The route writes its
 * `package.shared` audit off that flag and not off its own earlier read — the
 * offer may already have existed, or a concurrent activation may have written
 * it first (the insert is `onConflictDoNothing`), and an audit entry claiming
 * an act that did not happen is worse than none. `wasActive` is the same kind
 * of answer, for the status code and for the `package.activated` audit: it is
 * {@link isActiveHere} evaluated BEFORE the write, so a package the deployment
 * already switches on with no row at all (an offered system integration, a
 * system agent) answers 200 and records nothing — the row it gains states a
 * decision that changes nothing.
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
 * The home MOVE (`PATCH /api/packages/{scope}/{name}`) has to place the package
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
  const existing = await currentPlacement(tx, packageId, scope.spaceId);
  // The placement question, asked ONCE for both branches and BEFORE anything
  // is written — the offer this call may be about to create does not count.
  const placedBefore = await placedHere(tx, pkg, scope.spaceId);
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
      throw notFound(`Package '${packageId}' not found in organization catalog`);
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
 * Two callers, one sentence: {@link deactivatePackage}, which materializes the
 * sticky opt-out only for a package the default switches on, and
 * {@link updateSpacePackage}'s create-on-first-write, which must not turn
 * configuring into activating. An offer nobody has taken up is not "on": there
 * is nothing to switch off, and writing a row would erase the one state the
 * library shows as a pending offer.
 *
 * The rule itself is never re-derived here — {@link isActiveWithoutRow} IS the
 * deployment default (`services/package-activation.ts`), and this function
 * only decides what a refusal looks like. Two spellings of "active without a
 * row" in one file is exactly how the activation door and the configure door
 * drift apart. It is the default half rather than {@link isActiveHere} because
 * the other half has nothing to say with no row: the row is what carries a
 * space's decision, and the placement conjunct exists to discount a row the
 * space no longer holds.
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
 * model, proxy, generation settings and stored input values, so deleting it
 * would make "switch it off for a week" cost the configuration. Only the revoke
 * of the share that placed the package removes it (`revokePackageShare`), along
 * with the placement itself.
 *
 * Three answers, and they follow from the activation rule rather than from the
 * package's type:
 *
 *   - a row is here → set it to `false`;
 *   - NO row and the package is ON by the deployment's default (a system
 *     package, an integration named by `SYSTEM_INTEGRATIONS`) → materialize the
 *     row that says `false`. This is the sticky opt-out: the default is what
 *     switched the package on, and only an explicit row can outvote it, run
 *     after run;
 *   - NO row and the package is not on → 404. An offer nobody has taken up is
 *     not "on", so there is nothing to switch off, and writing a row would
 *     erase the one state the library shows as a pending offer — it would come
 *     back as "switched off", which is a different thing and a decision the
 *     recipient never made.
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
    const existing = await currentPlacement(tx, packageId, scope.spaceId);
    // Same pre-write verdict the activation door reads, for the same reason:
    // `changed` drives the `package.deactivated` audit, and an ORPHAN row was
    // never running anything to switch off.
    const wasActive = isActiveHere(pkg, existing, await placedHere(tx, pkg, scope.spaceId));

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
  // `orgOrSystemFilter` for the same reason as `getSpacePackage` below: a stray
  // association row pointing at another org's package (writable before the
  // atomic checks existed) must not surface that package's draft_manifest in
  // the listing.
  //
  // `placementReadFilter` for a second reason, and it is not the same one: a
  // row is not a placement. An ORPHAN row — neither homed here nor offered
  // here — describes a package this space has lost, and the projection carries
  // `draft_manifest`, so listing it would hand the space the display name and
  // description of somebody else's private draft. The space-package pages ask
  // the placement question exactly like every other reader.
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
    .leftJoin(
      packageShares,
      and(
        eq(packageShares.packageId, spacePackages.packageId),
        eq(packageShares.spaceId, scope.spaceId),
      ),
    )
    .where(and(...conditions));
}

export async function getSpacePackage(scope: SpaceScope, packageId: string) {
  // `orgOrSystemFilter` lands in the SQL WHERE so this can never act as a
  // cross-tenant existence/type oracle: a stray association row pointing at
  // another org's package id resolves to `null`, exactly like a package that
  // does not exist. `placementReadFilter` closes the same shape WITHIN the
  // org — an orphan row resolves to `null` too, so the detail route and the
  // run-config beside it cannot read back a package the space no longer holds
  // (the projection carries `draft_manifest`).
  const [row] = await db
    .select(spacePackageSelect)
    .from(spacePackages)
    .innerJoin(packages, eq(packages.id, spacePackages.packageId))
    .leftJoin(
      packageShares,
      and(
        eq(packageShares.packageId, spacePackages.packageId),
        eq(packageShares.spaceId, scope.spaceId),
      ),
    )
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
// Readable / active packages in a space (single query each)
// ---------------------------------------------------------------------------

/**
 * WHERE for "readable from this space, of this `type`" — the placement rule
 * ({@link placementReadFilter}), org-or-system owned, never an ephemeral
 * shadow. Expects `packageShares` LEFT JOINed on (package, this space).
 */
function readablePackagesFilter(scope: SpaceScope, type: PackageType) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    placementReadFilter(scope.spaceId),
  );
}

/**
 * WHERE for "ACTIVE in this space, of this `type`" — {@link activeHereSql}:
 * the placement row's verdict when there is one AND the package is placed
 * here, the deployment's default when there is not. Org-or-system owned, never
 * an ephemeral shadow. Expects BOTH of {@link activeHereSql}'s joins —
 * `spacePackages` and `packageShares`, each on (package, this space).
 *
 * Deliberately NOT the placement rule above. Reading and running are two
 * questions (RBAC spec §6.9): an agent homed here but switched off is listed
 * here and still refused a run, because it would run with THIS space's
 * credentials and the space said no. The predicate itself is
 * {@link activeHereSql}, shared with {@link hasPackageAccess} and with the
 * library's projection, and it feeds the caller-context hints — i.e. what the
 * model is told it may invoke.
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
 * ORDER BY for both listings above: system first, then by id. The
 * tie-break is load-bearing rather than cosmetic: Postgres does not order rows
 * within an equal sort key, so two identical calls could hand back different
 * permutations. The chat renders this list (capped, via
 * `listActivePackageHints`) into its system prompt, which pi-ai emits as ONE
 * cache block with ONE breakpoint — a reshuffle rewrites the prompt and
 * invalidates the cached prefix, and the conversation history behind it. It
 * also makes the CAP itself stable: without a total order, which 15 of N
 * packages survive the limit is undefined.
 */
function packageListingOrder() {
  return [sql`CASE WHEN ${packages.source} = 'system' THEN 0 ELSE 1 END`, packages.id];
}

/**
 * List every package of one `type` READABLE from a space — the placement rule
 * (`placementReadFilter`), so the index page of a type shows what the detail
 * page, the file explorer and the library already open: homed here, offered
 * here, or system.
 *
 * Single query via LEFT JOIN — no N+1. The `space_packages` join answers a
 * different question and is projected, not filtered on: `active` says whether
 * this space may RUN the package, which a placement alone does not grant.
 */
export async function listReadablePackages(scope: SpaceScope, type: PackageType) {
  return db
    .select({
      id: packages.id,
      type: packages.type,
      draftManifest: packages.draftManifest,
      draftContent: packages.draftContent,
      source: packages.source,
      // Whether the package is ACTIVE here — the placement row's `enabled` when
      // the space has one, the deployment's default when it has none. The run
      // routes gate on exactly this ({@link hasPackageAccess}), so a client
      // that renders a launch control per row can say why it is dead instead of
      // round-tripping to a 404. Not the same question as the WHERE above:
      // this listing is what a space READS.
      active: sql<boolean>`${activeHereSql(scope.spaceId)}`,
      // `latest` dist-tag version id — non-null iff the package has a published
      // version. Lets callers tell published agents from draft-only ones without
      // an N+1 (a draft-only agent must be run with `version=draft`).
      latestVersionId: packageDistTags.versionId,
    })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageShares,
      and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageDistTags,
      and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
    )
    .where(readablePackagesFilter(scope, type))
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
async function listActivePackageHints<T extends PackageHint>(
  scope: SpaceScope,
  type: PackageType,
  project: (base: PackageHint, manifest: Record<string, unknown>) => T,
  opts?: HintOptions,
): Promise<{ items: T[]; truncated: boolean; total: number }> {
  const limit = opts?.limit ?? DEFAULT_PACKAGE_HINT_LIMIT;
  const rows = await db
    .select({
      id: packages.id,
      type: packages.type,
      source: packages.source,
      homeSpaceId: packages.homeSpaceId,
      draftManifest: packages.draftManifest,
      // `latest` dist-tag version id — non-null iff the package has a
      // published version (see `listReadablePackages`).
      latestVersionId: packageDistTags.versionId,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageShares,
      and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageDistTags,
      and(eq(packageDistTags.packageId, packages.id), eq(packageDistTags.tag, "latest")),
    )
    .where(activePackagesFilter(scope, type))
    .orderBy(...packageListingOrder())
    .limit(limit);

  const total = rows[0]?.total ?? 0;

  const items = rows.map((row) => {
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
      home_writable: opts?.homeWritable?.(row) ?? false,
    };
    return project(base, manifest);
  });

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
    (base, manifest) => ({
      ...base,
      version: typeof manifest.version === "string" ? manifest.version : null,
    }),
    opts,
  );
  return { skills: items, truncated, total };
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
export async function hasPackageAccess(scope: SpaceScope, packageId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: packages.id })
    .from(packages)
    .leftJoin(
      spacePackages,
      and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, scope.spaceId)),
    )
    .leftJoin(
      packageShares,
      and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, scope.spaceId)),
    )
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
 * other reader of the table ({@link hasPackageAccess},
 * {@link getResolvedRunConfig}): `orgOrSystemFilter` so a row pointing at
 * another organization's package id resolves to defaults instead of handing
 * back its model and proxy override, and {@link placementReadFilter} so an
 * ORPHAN row — one with neither a home nor a share behind it, the residue
 * `scripts/migration/0016` repairs — reads as no row at all, exactly as it
 * does on every other surface.
 *
 * Stated here rather than left to each caller's own guard: a dozen call sites
 * reach this — the two run doors, the remote one, the scheduler tick, both
 * schedule routes, the agent model/proxy pair on both verbs, and the agent
 * detail — and a boundary held by convention is one the next of them drops in
 * silence. The predicate costs a join on an indexed column.
 *
 * Expects nothing of the caller beyond the scope: the `packages` INNER JOIN
 * and the `packageShares` LEFT JOIN that `placementReadFilter` reads are part
 * of this query.
 *
 * "No row it may act on" and "a row holding nothing" are deliberately the same
 * answer — the defaults below. Every caller resolves the same way over an
 * unconfigured placement, so the distinction would be one no caller could use.
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
    .leftJoin(
      packageShares,
      and(
        eq(packageShares.packageId, spacePackages.packageId),
        eq(packageShares.spaceId, scope.spaceId),
      ),
    )
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
    .leftJoin(
      packageShares,
      and(
        eq(packageShares.packageId, spacePackages.packageId),
        eq(packageShares.spaceId, scope.spaceId),
      ),
    )
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
 * `enabled` is deliberately NOT here. Activation has its own pair of doors
 * ({@link activatePackage} / {@link deactivatePackage}), which is what lets the
 * placement rule, the offer that may have to be created with it and the audit
 * of that act live in one place instead of being reachable through a settings
 * patch as well.
 *
 * The org-visibility check runs in the SAME transaction as the write — never
 * as a separate preflight — so the write can never graft an
 * `space_packages` row onto a package id the org cannot see (another
 * org's package, or an ephemeral shadow row).
 *
 * Two modes:
 *   - `requirePlacement: true` (the public
 *     `PUT /spaces/:id/packages/:packageId` route): the placement row
 *     MUST already exist — an update that would create a new row is a client
 *     error (404), never an implicit activation.
 *   - default (the agent input-settings / proxy / model routes): upsert, but
 *     ONLY where creating the row states no new decision. A package the
 *     deployment already switches on with no row — a system agent — legitimately
 *     has none until its first per-space setting is written, and the row it
 *     gains says `enabled = true`, which is what it already was. A package that
 *     is NOT on and has no row — a pending offer — is refused instead: writing
 *     the row there would activate it, and activation has one door
 *     ({@link activatePackage}), with the placement rule and the audit that go
 *     with it. Those routes preflight the package via `requireAgent()`, which
 *     asks PLACEMENT only; the in-transaction checks below re-enforce both
 *     boundaries atomically.
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
      throw notFound(`Package '${packageId}' not found in organization catalog`);
    }

    if (opts?.requirePlacement) {
      const updated = await tx
        .update(spacePackages)
        .set(set)
        .where(
          and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)),
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
