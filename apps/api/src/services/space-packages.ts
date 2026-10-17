// SPDX-License-Identifier: Apache-2.0

/**
 * Space-level package management — activate, deactivate, list, and configure
 * packages within a space context.
 *
 * `space_packages` is the PLACEMENT: one row per (package, space) carrying
 * `enabled`, the model, the proxy and the stored input settings. The doors in
 * this file are the only writers that CREATE one, and outside the package's
 * home only {@link placePackage} does. Deactivating keeps the row, so
 * deactivating and reactivating keeps every setting the space chose.
 *
 * A row is deleted only when the placement is withdrawn, through
 * `withdrawPlacement` (`services/package-placement.ts`), which disables the
 * package's schedules there too: `revokePackageShare`
 * (`services/package-shares.ts`) and the `keep: false` branch of
 * `reconcilePlacementsAfterRehome` — plus the cascades of the package's
 * deletion and the space's.
 * `setBlockUserConnections` (`services/integration-pins-service.ts`) writes here
 * too, but only UPDATES a column in place on an existing row.
 */

import { eq, and, exists, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@appstrate/db/client";
import { spacePackages, packages, packageDistTags, packageVersions } from "@appstrate/db/schema";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  MAX_ENFORCED_CHAT_SKILLS,
} from "@appstrate/core/chat-contract";
import { conflict, forbidden, notFound, parseBody } from "../lib/errors.ts";
import { inputSettingsSchema } from "../lib/jsonb-schemas.ts";
import { orgOrSystemFilter, notEphemeralFilter } from "../lib/package-helpers.ts";
import type { DbOrTx, Tx } from "../lib/db-helpers.ts";
import { asRecord } from "@appstrate/core/safe-json";
import type { PackageType } from "@appstrate/core/validation";
import type { ResolvedRunConfig } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import { assertSpaceInScope } from "./spaces.ts";
import { ApiError } from "../lib/errors.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { parsePackageZip } from "@appstrate/core/zip";
import { placementRowJoin } from "./package-placement.ts";
import {
  getLatestVersionId,
  getVersionForDownload,
  loadPublishedDefinition,
} from "./package-versions.ts";
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
 * Read the placement row of `(space, package)` inside a transaction.
 *
 * Every door needs it before it decides anything, and needs more than a
 * boolean: `activatePackage` reports whether it created the row and whether the
 * package was already active, and `deactivatePackage` tells "no row here yet"
 * from "a row that says false".
 *
 * `FOR UPDATE`: `revokePackageShare` deletes the row, and a bare SELECT here
 * would let a door decide on a row that is being deleted. Under the lock the
 * revoke waits for us, or we wait for it and re-read (READ COMMITTED) to find
 * no row, which sends the call down the branch that may not create one.
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
 * The catalog row every door starts from, or a 404 the caller cannot tell from
 * "no such package": the org-or-system predicate lands in the SQL WHERE, and an
 * ephemeral shadow row is never placeable.
 *
 * `FOR SHARE`, because `home_space_id` is read here and DECIDES whether a row
 * may be created without the placement door, while the home MOVE rewrites that
 * column. The lock order is `packages` before the `space_packages` row
 * ({@link currentPlacement}) on every path; a SHARE lock serializes a door
 * against a move while leaving concurrent doors in other spaces untouched.
 */
export async function loadPlaceablePackage(tx: Tx, scope: SpaceScope, packageId: string) {
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

/** Placed here without a row — shipped with the deployment, or homed here. */
function placedWithoutRow(
  pkg: { source: string | null; homeSpaceId: string | null },
  spaceId: string,
): boolean {
  return pkg.source === "system" || pkg.homeSpaceId === spaceId;
}

/**
 * Who places a package outside its home: the caller's id, recorded as the row's
 * `shared_by`, and their `<type>:share` authority in the home — the route's own
 * rule (`holdsHomeAuthority`), handed in as a predicate so the service stays
 * free of a Context while the decision is made against the LOCKED home rather
 * than the one the route read.
 */
export interface PlacementAuthority {
  sharedBy: string;
  authorizeHome: (homeSpaceId: string | null) => boolean;
}

/**
 * Place a package in a space outside its home — the ONE door that creates such
 * a row, used by `POST …/shares` (`sharePackage`, `services/package-shares.ts`)
 * and by the activation door ({@link activatePackageWithin}). Every
 * precondition lives here:
 *
 *   - the caller holds `<type>:share` in the LOCKED home (403) — first, because
 *     a caller who no longer governs the package must not learn whether the
 *     space they named is its home;
 *   - the target is not the home (409 `share_target_is_home`);
 *   - the package has a published version (409 `package_has_no_version`):
 *     outside its home a package runs its latest published version, so a
 *     placement with nothing published places nothing runnable.
 *
 * `enabled` is the caller's: `true` when they may activate in the target, so
 * the row is on as soon as it lands; `false` otherwise, and the space's members
 * switch it on themselves, since it runs with their credentials.
 *
 * `pkg` must have been read by `loadPlaceablePackage` in this transaction.
 * `ON CONFLICT DO NOTHING`: an existing row keeps its state and settings, and
 * `null` says this call created nothing.
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
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * 409 `package_has_no_version` unless the package has a published version —
 * {@link placePackage}'s third precondition, exported so a caller may ask it
 * BEFORE a side effect the refusal must not leave behind (the share route
 * provisioning a recipient's personal space). `placePackage` still asks it
 * inside its transaction, and that answer is the authoritative one.
 */
export async function assertHasPublishedVersion(packageId: string, executor: DbOrTx = db) {
  if ((await getLatestVersionId(packageId, executor)) === null) {
    throw conflict(
      "package_has_no_version",
      `Package '${packageId}' has no published version — publish one first, since a package runs its latest published version outside the space that owns it.`,
    );
  }
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
    generation_config: row.generationConfig,
    modelId: row.modelId,
    proxyId: row.proxyId,
    enabled: row.enabled,
    chat_enforced: row.chatEnforced,
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
 * Activate a package in a space — the ONE door, for a personal space and a team
 * space alike (RBAC spec §6.10), and an UPSERT rather than a create: the
 * placement row carries the space's model, proxy and stored input settings, so
 * putting a package down and picking it up again must not cost them. A second
 * activation of an active package is a no-op answering with the same body, not
 * a 409 — asking for a state the system is already in is not an error.
 *
 * An existing row is switched on with an UPDATE. Without one, the row is
 * created freely where the package is placed without it (home, system), and
 * elsewhere only through {@link placePackage}, with `placeAs` — the route
 * passes it when the caller holds `<type>:share` in the home
 * (`assertPackageShareAccess`). Without it the call is a 404, never a 403: the
 * package id may be private, and a named refusal would confirm it exists. So a
 * placement withdrawn while the call was in flight makes it refuse rather than
 * recreate the row.
 *
 * Writes neither initial values nor a version. `input_settings` has exactly one
 * write path (`PUT /api/agents/{scope}/{name}/input-settings`), and outside its
 * home a package runs the `latest` published version, always.
 *
 * Both returned flags answer for what this call DID, so the route's audits
 * cannot claim an act that did not happen: `shared` is set only when
 * {@link placePackage} created the row, and `wasActive` is {@link isActiveHere}
 * evaluated BEFORE the write — so a package the deployment already switches on
 * with no row answers 200 and records nothing.
 */
export async function activatePackage(
  scope: SpaceScope,
  packageId: string,
  opts?: { placeAs?: PlacementAuthority },
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
 * {@link activatePackage}'s body, inside a transaction the CALLER owns.
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
  opts?: { placeAs?: PlacementAuthority; keepExistingDecision?: boolean },
): Promise<PackageActivation> {
  const pkg = await loadPlaceablePackage(tx, scope, packageId);
  const existing = await currentPlacement(tx, packageId, scope.spaceId);
  // THE rule, read before the write (`services/package-activation.ts`).
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
    // `onConflictDoUpdate` rather than a bare INSERT: nothing locks a row that
    // does not exist yet, so two first activations racing each other both read
    // no placement, and the loser would take a unique-constraint 500 on an act
    // R16 makes idempotent. The cost is that `created` is decided by the read
    // above and can be true on both sides of that race — one duplicate audit
    // entry at worst, where the alternative is a 500 on a button press.
    const [row] = await tx
      .insert(spacePackages)
      .values({ spaceId: scope.spaceId, packageId, enabled: true })
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

/**
 * "There is NO row here — is the package on anyway?" — the deployment's
 * default, read by {@link deactivatePackage} before it materializes the sticky
 * opt-out. The rule is not re-derived here — {@link isActiveWithoutRow} IS the
 * deployment default; this only decides what the refusal looks like.
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
 * for a week" must not cost the configuration. Only withdrawing the placement
 * (`revokePackageShare`) removes it.
 *
 * Three answers, following from the activation rule, not from the type:
 *
 *   - a row is here → set it to `false`;
 *   - NO row and the package is ON by the deployment's default (a system
 *     package, an integration `SYSTEM_INTEGRATIONS` names) → materialize the row
 *     that says `false`. The sticky opt-out: only an explicit row outvotes the
 *     default, run after run;
 *   - NO row and the package is not on → 404: there is nothing to switch off.
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
    // Same pre-write verdict the activation door reads: `changed` drives the
    // `package.deactivated` audit.
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
  generation_config: spacePackages.generationConfig,
  modelId: spacePackages.modelId,
  proxyId: spacePackages.proxyId,
  enabled: spacePackages.enabled,
  chat_enforced: spacePackages.chatEnforced,
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
  // The org filter lands in the SQL WHERE so this is never an existence oracle:
  // a row pointing at another org's package resolves to `null`, exactly like a
  // package that does not exist. See `listSpacePackages` above.
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
 * WHERE for "ACTIVE in this space, of this `type`" — org-or-system owned,
 * never an ephemeral shadow. Expects {@link activeHereSql}'s join of
 * `spacePackages` on (package, this space).
 *
 * The predicate is {@link activeHereSql}, shared with
 * {@link isPackageActiveHere}, with the library's projection and with the index
 * listings, so what an index page shows, what the caller-context hints tell the
 * model it may invoke, and what the run gate lets through are one set.
 */
export function activePackagesFilter(scope: SpaceScope, type: PackageType) {
  return and(
    eq(packages.type, type),
    orgOrSystemFilter(scope.orgId),
    notEphemeralFilter(),
    activeHereSql(),
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
 * A package PLACED here and switched off is not on it. That state is the space library's subject
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
    .where(activePackagesFilter(scope, type))
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

/** ON clause for the package's non-yanked `latest` dist-tag — at most one row per package. */
export function latestTagJoin(packageIdColumn: AnyPgColumn) {
  return and(
    eq(packageDistTags.packageId, packageIdColumn),
    eq(packageDistTags.tag, "latest"),
    // A yanked target does not resolve as `latest` (`resolveVersionFromCatalog`).
    exists(
      db
        .select({ one: sql`1` })
        .from(packageVersions)
        .where(
          and(eq(packageVersions.id, packageDistTags.versionId), eq(packageVersions.yanked, false)),
        ),
    ),
  );
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
      // `latest` dist-tag version id — non-null iff the package has a published
      // version. Lets `published` below be answered without an N+1 (a draft-only
      // agent must be run with `version=draft`).
      latestVersionId: packageDistTags.versionId,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageDistTags, latestTagJoin(packages.id))
    .where(activePackagesFilter(scope, type))
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

/**
 * The RUN gate: is this package ACTIVE in this space?
 *
 * Deactivated means it does not execute (RBAC spec §6.10) — the switch the
 * space threw is the whole answer, and it is the same one the library renders
 * and the hints obey ({@link activeHereSql}). The row always wins, a system
 * package included: a space that switched one off runs it nowhere. With no row the deployment's default decides. Placement
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
    .where(
      and(
        eq(packages.id, packageId),
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        activeHereSql(),
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
 * Carries the tenant boundary IN this query, like every other reader of the
 * table ({@link isPackageActiveHere}, {@link getResolvedRunConfig}):
 * `orgOrSystemFilter` so a row pointing at another organization's package
 * resolves to defaults instead of handing back its model and proxy override. A
 * dozen call sites reach this — the run doors, the scheduler tick, the schedule
 * routes, the agent model/proxy pair, the detail — and a boundary held by
 * convention is one the next of them drops in silence.
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
 * Update the per-space settings row for `(spaceId, packageId)` — the model, the
 * proxy, the generation settings, the stored input values and — with
 * `requirePlacement` only, never on a create — the chat enforcement flag, and
 * nothing else. `chatEnforcedChanged` says whether the write moved that flag.
 *
 * `enabled` is NOT here: activation has its own pair of doors
 * ({@link activatePackage} / {@link deactivatePackage}), which keeps the
 * placement rule, the placement it may create and the audit in one place.
 *
 * The org-visibility check runs in the SAME transaction as the write, so the
 * write can never graft a row onto a package id the org cannot see.
 *
 * Two modes:
 *   - `requirePlacement: true` (the public
 *     `PUT /spaces/:id/packages/:packageId` route): the placement row MUST
 *     already exist — creating one is a 404, never an implicit activation.
 *   - default (the agent input-settings / proxy / model routes): an existing
 *     row is updated; without one, a row is created only where the package is
 *     placed without it — its home, or a system package — and its `enabled`
 *     is the deployment default, so creating it changes no verdict. Anywhere
 *     else it is a 404: placing a package outside its home is
 *     {@link placePackage}'s alone. Those routes preflight via `requireAgent()`,
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
    chatEnforced?: boolean;
  },
  /** `tx`: join the caller's transaction instead of opening one. */
  opts?: { requirePlacement?: boolean; tx?: Tx },
): Promise<{ chatEnforcedChanged: boolean }> {
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

  const work = async (tx: Tx) => {
    // Tenant boundary, atomic with the write: the target package must be
    // visible to the org (own or system) and not an ephemeral shadow row.
    const [pkg] = await tx
      .select({
        id: packages.id,
        type: packages.type,
        source: packages.source,
        homeSpaceId: packages.homeSpaceId,
      })
      .from(packages)
      .where(and(eq(packages.id, packageId), orgOrSystemFilter(scope.orgId), notEphemeralFilter()))
      .limit(1);
    if (!pkg) {
      throw notFound(`Package '${packageId}' not found in this organization`);
    }

    if (opts?.requirePlacement) {
      const { chatEnforced } = updates;
      // Read under the row lock, so the caller's audit names a real change.
      const before =
        chatEnforced === undefined ? null : await currentPlacement(tx, packageId, scope.spaceId);
      const updated = await tx
        .update(spacePackages)
        .set(chatEnforced === undefined ? set : { ...set, chatEnforced })
        .where(
          and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)),
        )
        .returning({ packageId: spacePackages.packageId });
      if (updated.length === 0) {
        throw notFound(`Package '${packageId}' is not placed in this space`);
      }
      return {
        chatEnforcedChanged: chatEnforced !== undefined && before?.chatEnforced !== chatEnforced,
      };
    }

    const existing = await currentPlacement(tx, packageId, scope.spaceId);
    if (existing) {
      await tx
        .update(spacePackages)
        .set(set)
        .where(
          and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.packageId, packageId)),
        );
      return { chatEnforcedChanged: false };
    }
    // Create-on-first-write, only where the package is placed without a row
    // and with the verdict it already had: configuring is never activating.
    if (!placedWithoutRow(pkg, scope.spaceId)) {
      throw notFound(`Package '${packageId}' is not placed in this space`);
    }
    await tx
      .insert(spacePackages)
      .values({
        spaceId: scope.spaceId,
        packageId,
        enabled: isActiveWithoutRow(pkg),
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
    return { chatEnforcedChanged: false };
  };
  return opts?.tx ? work(opts.tx) : db.transaction(work);
}

type PlacementSettings = Parameters<typeof updateSpacePackage>[2];

/**
 * Enforcing writes first and checks after, under a per-space lock: concurrent
 * enforcements cannot both pass the cap, an unplaced 404 precedes any 409, and
 * a refusal rolls the whole patch back.
 */
export async function updatePlacementSettings(
  scope: SpaceScope,
  packageId: string,
  updates: PlacementSettings,
): Promise<{ chatEnforcedChanged: boolean }> {
  if (!updates.chatEnforced) {
    return updateSpacePackage(scope, packageId, updates, { requirePlacement: true });
  }
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`space-chat-enforced:${scope.spaceId}`})::bigint)`,
    );
    const result = await updateSpacePackage(scope, packageId, updates, {
      requirePlacement: true,
      tx,
    });
    if (result.chatEnforcedChanged) await assertChatEnforceable(scope, packageId, tx);
    return result;
  });
}

// Every read goes through `tx`: under PGlite's single connection a query on
// the root `db` would wait on this very transaction.
async function assertChatEnforceable(scope: SpaceScope, packageId: string, tx: Tx) {
  const own = await loadPublishedDefinition("skill", packageId, "latest", tx);
  if (!own) {
    throw conflict(
      "no_published_version",
      `Skill '${packageId}' has no published version to enforce — publish it first`,
    );
  }

  // Every flagged row counts, enabled or not: re-activation brings the flag back unchecked.
  const flagged = await tx
    .select({ packageId: spacePackages.packageId })
    .from(spacePackages)
    .where(and(eq(spacePackages.spaceId, scope.spaceId), eq(spacePackages.chatEnforced, true)));
  if (flagged.length > MAX_ENFORCED_CHAT_SKILLS) {
    throw conflict(
      "enforced_skills_limit",
      `A space enforces at most ${MAX_ENFORCED_CHAT_SKILLS} skills in its chat`,
      { limit: MAX_ENFORCED_CHAT_SKILLS },
    );
  }

  const others = await Promise.all(
    flagged
      .filter((row) => row.packageId !== packageId)
      .map((row) => loadPublishedDefinition("skill", row.packageId, "latest", tx)),
  );
  const total = others.reduce(
    (sum, skill) => sum + (skill?.content.length ?? 0),
    own.content.length,
  );
  if (total > CHAT_SKILLS_CONTENT_BUDGET_CHARS) {
    throw conflict(
      "enforced_skills_budget",
      `The enforced skills would total ${total} characters; the chat budget is ${CHAT_SKILLS_CONTENT_BUDGET_CHARS}`,
      { budget: CHAT_SKILLS_CONTENT_BUDGET_CHARS, total },
    );
  }
}
