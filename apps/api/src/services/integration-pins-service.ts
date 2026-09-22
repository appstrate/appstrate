// SPDX-License-Identifier: Apache-2.0

/**
 * Service layer for `integration_pins` + the per-(space, integration)
 * `block_user_connections` toggle + connection metadata edits
 * (label, sharedWithOrg). Consumed by the routes in `routes/integrations.ts`.
 *
 * Pin model (flat): one SET per (space, agent, integration, scope), one row
 * per bound connection.
 * Scope = admin (`user_id IS NULL`) OR member (`user_id = caller.id`).
 * The pin row carries a `connection_id`; the connection's own `auth_key`
 * is denormalised on the PinSummary for display but never part of the
 * uniqueness key — OAuth and api_key connections are interchangeable at
 * runtime.
 *
 * All governance operations — the route layer enforces
 * `requirePermission("integrations", "configure")`; this layer assumes the
 * caller already holds it.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  spacePackages,
  packageShares,
  integrationConnections,
  integrationPins,
  integrationOrgDefaults,
  packages,
} from "@appstrate/db/schema";
import type {
  IntegrationConnectionRow as ConnectionRow,
  IntegrationPinRow as PinRow,
} from "@appstrate/db/schema";
import type {
  AccessibleIntegrationConnection,
  ConsumingAgentSummary,
  IntegrationAgentResolution,
  IntegrationCandidate,
  IntegrationPickStatus,
  IntegrationPin,
} from "@appstrate/shared-types";
import {
  missingScopesForConnection,
  manifestAuthKeySet,
  labelsSharedBy,
  normalizeConnectionIds,
  MAX_CONNECTIONS_PER_INTEGRATION,
  type ConnectionResolutionSource,
} from "@appstrate/core/integration";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { activatePackageWithin, isPackageActiveHere, placedRowFilter } from "./space-packages.ts";
import { activeHereSql } from "./package-activation.ts";
import {
  getPackageDisplayName,
  notEphemeralFilter,
  orgOrSystemFilter,
} from "../lib/package-helpers.ts";
import { conflict, notFound, invalidRequest } from "../lib/errors.ts";
import type { SpaceScope } from "../lib/scope.ts";
import { actorOrSharedFilter, type Actor } from "../lib/actor.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import { getPackage } from "./package-catalog.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import { fetchIntegrationManifest, resolveRunIntegrationVersions } from "./integration-service.ts";
import { getOrgDefault } from "./integration-org-defaults-service.ts";
import { resolveConnectionOwnerNames } from "./integration-connection-owner-names.ts";
import {
  resolveConnectionsForRun,
  translateResolutionError,
  isUserConnectionCreationBlocked,
  duplicateLabelMessage,
} from "./integration-connection-resolver.ts";
import type { ConnectionResolutionResult } from "@appstrate/core/integration";
import type { IntegrationManifestCache } from "./integration-service.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";

// Canonical wire shapes live in @appstrate/shared-types so the frontend
// hook and OpenAPI spec can't drift from the service. Local aliases keep
// the existing call sites readable.
type PinSummary = IntegrationPin;

// ─────────────────────────── block_user_connections toggle ────────────────────

/**
 * Toggle the per-(space, integration) lock.
 *
 * An existing `space_packages` row is updated in place — but only where the
 * package is PLACED here ({@link placedRowFilter}), the same conjunct the
 * READER of this flag applies (`isUserConnectionCreationBlocked`). On the bare
 * `(space_id, package_id)` pair this would answer `200 blocked: true` on an
 * ORPHAN row while the gate went on letting every member create a personal
 * connection — a padlock drawn over an open door.
 *
 * With NO row the toggle still has to persist, and the row it needs is a
 * PLACEMENT row — which makes creating it an activation, not a side effect. It
 * goes through the one door that writes them (`activatePackageWithin`), inside
 * this transaction, rather than spelling the INSERT a second time.
 *
 * That door reports whether the package was ALREADY active, and only that case
 * may proceed: an integration `SYSTEM_INTEGRATIONS` offers is active with no
 * row, so materializing one records the flag and changes no verdict — hence no
 * `package.activated` audit and no activation grant. Anything else would be
 * switched ON by the row, and recording a connection lock is not a decision to
 * switch an integration on, so the throw rolls the transaction back. The same
 * door refuses the orphan the UPDATE just skipped: no home, no share, no
 * `shareBy`, its own 404 before the row is touched.
 */
export async function setBlockUserConnections(
  scope: SpaceScope,
  integrationId: string,
  blocked: boolean,
): Promise<{ blocked: boolean }> {
  return db.transaction(async (tx) => {
    const writeFlag = () =>
      tx
        .update(spacePackages)
        .set({ blockUserConnections: blocked, updatedAt: new Date() })
        .where(
          and(
            eq(spacePackages.spaceId, scope.spaceId),
            eq(spacePackages.packageId, integrationId),
            placedRowFilter(tx, scope.spaceId, integrationId),
          ),
        )
        .returning({ blockUserConnections: spacePackages.blockUserConnections });

    const updated = await writeFlag();
    if (updated.length > 0) return { blocked: updated[0]!.blockUserConnections };

    const activation = await activatePackageWithin(tx, scope, integrationId);
    if (!activation.wasActive) {
      throw notFound(`Integration '${integrationId}' is not active in this space`);
    }
    // The door above either found the package placed here or created the
    // share that places it, so this second write matches — an orphan never
    // reaches it.
    const [materialized] = await writeFlag();
    return { blocked: materialized!.blockUserConnections };
  });
}

// ─────────────────────────── Pin CRUD ─────────────────────────────────────────

/**
 * Cap + {@link normalizeConnectionIds} + sort, at every set WRITE. Sorting is
 * what gives a set ONE representation: its rows share a write timestamp, so
 * nothing but the id can order a read of them.
 */
export function canonicalConnectionSet(ids: string[], field: string): string[] {
  if (ids.length === 0 || ids.length > MAX_CONNECTIONS_PER_INTEGRATION) {
    throw invalidRequest(
      `\`${field}\` must hold between 1 and ${MAX_CONNECTIONS_PER_INTEGRATION} connection ids`,
    );
  }
  const normalized = normalizeConnectionIds(ids);
  if (normalized === null) {
    throw invalidRequest(`\`${field}\` must not repeat a connection id`);
  }
  return normalized.sort();
}

/** Refuse a colliding set here; the resolver re-checks for a LATER rename. */
export function assertDistinctConnectionLabels(
  integrationId: string,
  rows: readonly ConnectionRow[],
): void {
  const colliding = labelsSharedBy(rows);
  if (colliding.length > 0) {
    throw invalidRequest(duplicateLabelMessage(integrationId, colliding));
  }
}

interface PinJoinRow {
  pin: PinRow;
  conn: ConnectionRow | null;
}

/** Fold one pin's N rows into one summary; `createdAt` = the current set's write. */
function toPinSummaries(rows: PinJoinRow[]): PinSummary[] {
  const byPin = new Map<string, PinJoinRow[]>();
  for (const row of rows) {
    const key = `${row.pin.packageId}|${row.pin.integrationId}`;
    const bucket = byPin.get(key);
    if (bucket) bucket.push(row);
    else byPin.set(key, [row]);
  }
  return [...byPin.values()].map((group) => {
    const first = group[0]!;
    return {
      packageId: first.pin.packageId,
      integration_package_id: first.pin.integrationId,
      auth_key: first.conn?.authKey ?? "",
      connection_ids: group.map((r) => r.pin.connectionId),
      createdAt: first.pin.createdAt.toISOString(),
      updatedAt: first.pin.updatedAt.toISOString(),
    };
  });
}

/**
 * List every admin pin governing a (space, integration). Used by the admin UI
 * to render the per-agent pin section + by the runtime resolver via the
 * dedicated `loadPins` helper (private to the resolver, see
 * integration-connection-resolver.ts).
 */
export async function listIntegrationPins(
  scope: SpaceScope,
  integrationId: string,
): Promise<PinSummary[]> {
  const rows = await db
    .select({ pin: integrationPins, conn: integrationConnections })
    .from(integrationPins)
    .leftJoin(integrationConnections, eq(integrationConnections.id, integrationPins.connectionId))
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.integrationId, integrationId),
        isNull(integrationPins.userId),
      ),
    )
    .orderBy(integrationPins.connectionId);
  return toPinSummaries(rows);
}

/**
 * R2 — agents this space RUNS that declare the given integration in their
 * dependencies. Powers the centralised pin management table on the
 * integration detail page (so the admin can pick which agent to pin without
 * leaving the integration view).
 *
 * ACTIVE, not "holds a row" ({@link activeHereSql}): a pin names the agent a
 * run will use this connection for, and a deactivated agent — or an ORPHAN
 * row, a decision about a package this space has lost — runs nowhere, so
 * offering it as a pin target would offer a pin that can never fire. Written
 * in the query builder rather than as raw SQL so the rule is CONJOINED here
 * rather than copied.
 */
export async function listAgentsConsumingIntegration(
  scope: SpaceScope,
  integrationId: string,
): Promise<ConsumingAgentSummary[]> {
  const rows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .leftJoin(spacePackages, placementRowJoin(packages.id, scope.spaceId))
    .leftJoin(packageShares, placementShareJoin(packages.id, scope.spaceId))
    .where(
      and(
        eq(packages.type, "agent"),
        orgOrSystemFilter(scope.orgId),
        notEphemeralFilter(),
        activeHereSql(scope.spaceId),
        sql`(${packages.draftManifest} -> 'dependencies' -> 'integrations') ? ${integrationId}`,
      ),
    )
    .orderBy(packages.id);

  return rows.map((r) => ({
    packageId: r.id,
    display_name: getPackageDisplayName(r),
  }));
}

interface SetPinInput {
  agentPackageId: string;
  connectionIds: string[];
  createdBy: string | null;
}

/**
 * Replace the admin pin set. Validates that EVERY pinned connection:
 *   1. exists in the same space,
 *   2. references the integration this pin governs,
 *   3. is `sharedWithOrg=true` (pinning a personal connection would
 *      leak the admin's identity to other members at run time).
 *
 * Each connection carries its own authKey — pinning a PAT connection
 * overrides the agent's oauth-by-default just by virtue of being picked.
 */
export async function upsertIntegrationPin(
  scope: SpaceScope,
  integrationId: string,
  input: SetPinInput,
  /** TEST seam (`revokePackageShare`'s shape): runs in-transaction, pre-commit. */
  opts?: { onBeforeCommit?: () => Promise<void> },
): Promise<PinSummary> {
  return upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId,
    connectionIds: input.connectionIds,
    userIdValue: null,
    validateOpts: { requireShared: true },
    createdBy: input.createdBy,
    ...(opts?.onBeforeCommit ? { onBeforeCommit: opts.onBeforeCommit } : {}),
  });
}

/**
 * Delete-then-insert rather than a per-row upsert: a connection the caller
 * dropped must disappear with the write that adds the new ones.
 */
async function upsertPin(args: {
  scope: SpaceScope;
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
  userIdValue: string | null;
  validateOpts: { requireShared?: boolean; allowOwnedBy?: string };
  createdBy: string | null;
  onBeforeCommit?: () => Promise<void>;
}): Promise<PinSummary> {
  const { scope, agentPackageId, integrationId, userIdValue, createdBy } = args;
  const connectionIds = canonicalConnectionSet(args.connectionIds, "connection_ids");
  const conns = await Promise.all(
    connectionIds.map((id) => validatePinTarget(scope, integrationId, id, args.validateOpts)),
  );
  assertDistinctConnectionLabels(integrationId, conns);
  await assertAgentActiveHere(scope, agentPackageId);

  const now = new Date();
  const userPredicate =
    userIdValue === null ? isNull(integrationPins.userId) : eq(integrationPins.userId, userIdValue);
  const lockKey = `ip_set:${scope.spaceId}:${agentPackageId}:${integrationId}:${userIdValue ?? ""}`;

  await db.transaction(async (tx) => {
    // Not atomic under READ COMMITTED: without this, two concurrent PUTs both
    // delete what they can see, both insert, and the UNION survives.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);
    await tx
      .delete(integrationPins)
      .where(
        and(
          eq(integrationPins.spaceId, scope.spaceId),
          eq(integrationPins.packageId, agentPackageId),
          eq(integrationPins.integrationId, integrationId),
          userPredicate,
        ),
      );
    await tx.insert(integrationPins).values(
      connectionIds.map((connectionId) => ({
        spaceId: scope.spaceId,
        packageId: agentPackageId,
        integrationId,
        userId: userIdValue,
        connectionId,
        createdBy,
        createdAt: now,
        updatedAt: now,
      })),
    );
    if (args.onBeforeCommit) await args.onBeforeCommit();
  });

  return {
    packageId: agentPackageId,
    integration_package_id: integrationId,
    auth_key: conns[0]!.authKey,
    connection_ids: connectionIds,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteIntegrationPin(
  scope: SpaceScope,
  integrationId: string,
  agentPackageId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.integrationId, integrationId),
        eq(integrationPins.packageId, agentPackageId),
        isNull(integrationPins.userId),
      ),
    )
    .returning({ id: integrationPins.id });
  return { deleted: result.length > 0 };
}

/**
 * A pin names the agent a run will resolve this connection FOR, so the
 * question is ACTIVATION and not the presence of a row: a deactivated agent,
 * and an orphan row naming a package this space no longer holds, both run
 * nowhere. {@link isPackageActiveHere} is the ONE rule and carries the org
 * boundary in its own query — which is why the message now matches the check.
 */
async function assertAgentActiveHere(scope: SpaceScope, agentPackageId: string): Promise<void> {
  if (!(await isPackageActiveHere(scope, agentPackageId))) {
    throw notFound(`Agent '${agentPackageId}' is not active in this space`);
  }
}

export async function validatePinTarget(
  scope: SpaceScope,
  integrationId: string,
  connectionId: string,
  opts: { requireShared?: boolean; allowOwnedBy?: string },
): Promise<ConnectionRow> {
  const [conn] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  if (!conn) throw notFound(`Connection '${connectionId}' not found`);
  if (conn.spaceId !== scope.spaceId) {
    throw invalidRequest("Pinned connection belongs to a different space");
  }
  if (conn.integrationId !== integrationId) {
    throw invalidRequest(
      `Pinned connection belongs to integration '${conn.integrationId}', not '${integrationId}'`,
    );
  }
  if (opts.requireShared) {
    if (!conn.sharedWithOrg) {
      throw invalidRequest(
        "Pinned connection must be marked sharedWithOrg=true before it can be pinned for other members",
      );
    }
  } else if (opts.allowOwnedBy !== undefined) {
    const accessible = conn.userId === opts.allowOwnedBy || conn.sharedWithOrg;
    if (!accessible) {
      throw invalidRequest(
        "Pinned connection must be owned by you or shared with the org before you can pin it",
      );
    }
  }
  return conn;
}

// ─────────────────────────── Member-pin CRUD ─────────────────────────────────

interface UpsertMemberPinInput {
  agentPackageId: string;
  integrationId: string;
  connectionIds: string[];
  userId: string;
}

/**
 * Replace the member-scope pin set (`integration_pins` rows with `user_id`).
 *
 * Member writes their own preference for this (agent, integration) —
 * the persisted rows the resolver sees on every run (layer 5 of the
 * cascade).
 */
export async function upsertMemberPin(
  scope: SpaceScope,
  input: UpsertMemberPinInput,
): Promise<PinSummary> {
  return upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId: input.integrationId,
    connectionIds: input.connectionIds,
    userIdValue: input.userId,
    validateOpts: { allowOwnedBy: input.userId },
    createdBy: input.userId,
  });
}

export async function deleteMemberPin(
  scope: SpaceScope,
  agentPackageId: string,
  integrationId: string,
  userId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.integrationId, integrationId),
        eq(integrationPins.userId, userId),
      ),
    )
    .returning({ id: integrationPins.id });
  return { deleted: result.length > 0 };
}

/**
 * List the caller's own member pins for an agent. Drives the agent-page
 * picker — UI checks "is this integration already pinned by me?" and
 * renders the collapsed "Using: X" row pointing at the pinned connections.
 */
interface MemberPinSummary {
  integration_package_id: string;
  connection_ids: string[];
}

export async function listMemberPinsForAgent(
  scope: SpaceScope,
  agentPackageId: string,
  userId: string,
): Promise<MemberPinSummary[]> {
  const rows = await db
    .select({
      integrationId: integrationPins.integrationId,
      connectionId: integrationPins.connectionId,
    })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.spaceId, scope.spaceId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.userId, userId),
      ),
    )
    .orderBy(integrationPins.connectionId);

  const byIntegration = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byIntegration.get(row.integrationId);
    if (ids) ids.push(row.connectionId);
    else byIntegration.set(row.integrationId, [row.connectionId]);
  }
  return [...byIntegration].map(([integration_package_id, connection_ids]) => ({
    integration_package_id,
    connection_ids,
  }));
}

// ─────────────────────────── Connection metadata edits ────────────────────────

interface UpdateConnectionMetadataInput {
  /** A rename, never a clear — the column is NOT NULL. */
  label?: string;
  sharedWithOrg?: boolean;
}

/**
 * Update a connection's label and/or sharedWithOrg flag. Caller-owned
 * connections only — actor authorization is enforced in the route
 * (only the owner OR an admin can mutate metadata; sharedWithOrg
 * specifically requires the owner since sharing is consent).
 *
 * Refuses turning sharedWithOrg=false when the connection is referenced
 * by ≥1 pin — admins must remove the pin first, otherwise the pinned
 * resolution would silently break for every member at the next run.
 */
export async function updateConnectionMetadata(
  connectionId: string,
  input: UpdateConnectionMetadataInput,
): Promise<ConnectionRow> {
  if (input.sharedWithOrg === false) {
    const [pins, orgDefaults] = await Promise.all([
      db
        .select({ packageId: integrationPins.packageId })
        .from(integrationPins)
        .where(eq(integrationPins.connectionId, connectionId))
        .limit(1),
      db
        .select({ id: integrationOrgDefaults.id })
        .from(integrationOrgDefaults)
        .where(eq(integrationOrgDefaults.connectionId, connectionId))
        .limit(1),
    ]);
    if (pins.length > 0) {
      // Existence check only (`.limit(1)`), so don't claim a count.
      throw conflict(
        "connection_pinned",
        "Connection cannot be unshared while it is pinned to one or more agents. Remove the pin(s) first.",
      );
    }
    if (orgDefaults.length > 0) {
      throw conflict(
        "connection_pinned",
        "Connection cannot be unshared while it is the org default for an integration. Remove the default first.",
      );
    }
  }

  const updates: { label?: string; sharedWithOrg?: boolean; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (input.label !== undefined) updates.label = input.label;
  if (input.sharedWithOrg !== undefined) updates.sharedWithOrg = input.sharedWithOrg;

  const result = await db
    .update(integrationConnections)
    .set(updates)
    .where(eq(integrationConnections.id, connectionId))
    .returning();
  if (result.length === 0) throw notFound(`Connection '${connectionId}' not found`);
  return result[0]!;
}

/** Used by route handlers to enforce ownership before metadata edits. */
export async function loadConnectionOwnership(connectionId: string): Promise<{
  spaceId: string;
  userId: string | null;
  endUserId: string | null;
} | null> {
  const [row] = await db
    .select({
      spaceId: integrationConnections.spaceId,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
    })
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId))
    .limit(1);
  return row ?? null;
}

// ─────────────────────────── Shared accessor for the picker UI ────────────────

/**
 * List the connections an actor can pick from for a given
 * (space, integration). Used by the UI picker:
 * own + shared, with caller-facing labels.
 *
 * Same set — and now the same predicate — as `listIntegrationConnections`
 * on the settings surface; only the projected DTO differs (this one carries
 * `owner_name` and the split owner ids the picker keys on, the other the
 * full connection summary). Both go through `actorOrSharedFilter`, so the
 * two surfaces cannot drift on what "accessible" means.
 */
export async function listAccessibleConnections(
  scope: SpaceScope,
  integrationId: string,
  actor: Actor,
): Promise<AccessibleIntegrationConnection[]> {
  const rows = await db
    .select()
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.spaceId, scope.spaceId),
        eq(integrationConnections.integrationId, integrationId),
        actorOrSharedFilter(actor, integrationConnections),
      ),
    );
  return attachOwnerNames(rows);
}

/**
 * Project the connection rows into picker summaries, resolving owner
 * display names via the shared batched lookup. Keeps the dual own/shared
 * query path untouched — names are a post-pass over whatever rows
 * survived the merge.
 */
async function attachOwnerNames(rows: ConnectionRow[]): Promise<AccessibleIntegrationConnection[]> {
  const ownerName = await resolveConnectionOwnerNames(rows);

  return rows.map((row) => ({
    id: row.id,
    auth_key: row.authKey,
    account_id: row.accountId,
    label: row.label,
    owner_user_id: row.userId,
    owner_end_user_id: row.endUserId,
    owner_name: ownerName(row),
    scopes_granted: row.scopesGranted ?? [],
    shared_with_org: row.sharedWithOrg,
    needs_reconnection: row.needsReconnection,
  }));
}

// ─────────────────────────── Agent-page picker resolution ─────────────────────

/**
 * Map a resolver `source` to the picker's status badge. A force layer (admin
 * pin / enforced org default) reads as `admin_locked`; the actor's own member
 * pin as `pinned`; every remaining source (override / soft default / fallback)
 * is an unforced `auto`. Single definition so the `resolved` and the
 * `insufficient_scopes` branches can't drift on this mapping.
 */
function pickStatusForSource(source: ConnectionResolutionSource): IntegrationPickStatus {
  if (source === "admin_pin" || source === "org_default_enforced") return "admin_locked";
  if (source === "member_pin") return "pinned";
  return "auto";
}

/**
 * The single-source verdict for the agent-page connection picker: which
 * connection the next run would use for this (agent, integration, actor),
 * plus the candidate list and pin/blocked state the dropdown renders.
 *
 * The "which connection" decision delegates to {@link resolveConnectionsForRun}
 * — the exact cascade (admin pin → run/schedule override → member pin →
 * fallback) + scope check the runtime uses — so the UI never re-implements
 * it. Per-candidate `missingScopes` are an additional display annotation
 * (the resolver only scope-checks the one resolved connection).
 *
 * `agentManifest` and `resolution` are REQUIRED and caller-supplied, which is
 * load-bearing rather than stylistic. This function used to load the package
 * itself and read `agent.manifest` — always the DRAFT — while its only caller
 * had already resolved the manifest for the requested `version`. On
 * `?version=<pinned>` the response therefore described the pinned version in
 * `blocks_run` and the draft in every `integrations[].resolution`, defeating
 * the reason #770 introduced the selector. Taking both as parameters makes
 * that divergence unrepresentable: there is no manifest in scope here to read
 * the wrong one from. It also removes an N+1 — the cascade ran once per
 * declared integration, each time re-fetching the package and every manifest.
 */
async function resolveAgentIntegrationPick(args: {
  scope: SpaceScope;
  agentPackageId: string;
  integrationId: string;
  actor: Actor;
  canConfigureIntegrations: boolean;
  /** The manifest of the version under inspection — never re-read from the package. */
  agentManifest: Record<string, unknown>;
  /** Agent-level `includeInert: true` cascade, resolved once for every integration. */
  resolution: ConnectionResolutionResult;
  /** Agent-level member pins, fetched once. */
  memberPins: MemberPinSummary[];
  /** Shared integration-manifest memo, so N integrations cost N fetches, not N². */
  manifestCache: IntegrationManifestCache;
}): Promise<IntegrationAgentResolution> {
  const {
    scope,
    agentPackageId,
    integrationId,
    actor,
    canConfigureIntegrations,
    agentManifest,
    resolution,
  } = args;

  const agentEntry = parseManifestIntegrations(agentManifest).find((e) => e.id === integrationId);
  // AFPS §4.4 — preserve the wildcard literal `"*"` so `missingScopesForConnection`
  // can route through the default-scopes branch of `requiredScopesForAgent`.
  // Coercing `"*"` to `[]` here would silently bypass the scope diff and let
  // a connection with zero default scopes appear "fully connected".
  const agentTools: readonly string[] | "*" = agentEntry?.tools ?? [];
  const agentScopes = agentEntry?.scopes ?? [];

  const manifestRes = await fetchIntegrationManifest(integrationId, args.manifestCache);
  const manifest = manifestRes.ok ? manifestRes.manifest : null;

  const memberPins = args.memberPins;

  const [candidatesRaw, adminPins, blocked, orgDefault] = await Promise.all([
    listAccessibleConnections(scope, integrationId, actor),
    listIntegrationPins(scope, integrationId),
    isUserConnectionCreationBlocked(scope.spaceId, integrationId),
    getOrgDefault(scope, integrationId),
  ]);

  const adminPinnedConnectionIds =
    adminPins.find((p) => p.packageId === agentPackageId)?.connection_ids ?? [];
  const memberPinnedConnectionIds =
    memberPins.find((p) => p.integration_package_id === integrationId)?.connection_ids ?? [];
  const orgDefaultConnectionIds = orgDefault?.connection_ids ?? [];
  const orgDefaultEnforced = orgDefault?.enforce ?? false;

  // Drop orphaned-auth connections: a row whose `auth_key` no longer exists in
  // the integration's current manifest can never be delivered (the spawn
  // resolver matches connection → auth by `authKey`). Shared `manifestAuthKeySet`
  // keeps this guard — and its `null` = "no constraint" semantics — identical to
  // the runtime resolver's, so the picker and the run path can't disagree about
  // which connections are live.
  const liveAuthKeys = manifestAuthKeySet(manifest);
  const candidates: IntegrationCandidate[] = candidatesRaw
    .filter((c) => liveAuthKeys === null || liveAuthKeys.has(c.auth_key))
    .map((c) => ({
      ...c,
      missing_scopes: manifest
        ? missingScopesForConnection({
            manifest,
            authKey: c.auth_key,
            granted: c.scopes_granted,
            agentTools,
            agentScopes,
          })
        : [],
      is_own:
        actor.type === "user" ? c.owner_user_id === actor.id : c.owner_end_user_id === actor.id,
    }));

  const resolved = resolution.resolved[integrationId] ?? null;
  const err = resolution.errors.find((e) => e.integrationId === integrationId) ?? null;

  let status: IntegrationPickStatus;
  let resolvedConnectionIds: string[] = [];
  let resolvedMissingScopes: string[] = [];

  if (resolved) {
    resolvedConnectionIds = resolved.map((r) => r.connectionId);
    status = pickStatusForSource(resolved[0]!.source);
  } else if (err) {
    switch (err.code) {
      case "insufficient_scopes":
        resolvedConnectionIds = err.connectionId ? [err.connectionId] : [];
        resolvedMissingScopes = err.missingScopes ?? [];
        status = err.source ? pickStatusForSource(err.source) : "auto";
        break;
      case "must_choose_connection":
        status = "must_choose";
        break;
      case "duplicate_connection_label":
        status = "duplicate_label";
        break;
      case "needs_reconnection":
        status = "needs_reconnection";
        break;
      case "pinned_connection_unavailable":
      case "override_connection_unavailable":
        status = "stale";
        break;
      default:
        status = "none";
    }
  } else {
    // No verdict at all — only reachable when the integration manifest couldn't
    // be fetched (buildRequirement returned null, so the resolver never saw it,
    // `includeInert` notwithstanding). The pin cascade can't run without the
    // manifest; fall back to a sane label from the candidate count.
    status = candidates.length === 1 ? "auto" : candidates.length === 0 ? "none" : "must_choose";
    if (candidates.length === 1) resolvedConnectionIds = [candidates[0]!.id];
  }

  return {
    status,
    resolved_connection_ids: resolvedConnectionIds,
    resolved_missing_scopes: resolvedMissingScopes,
    admin_pinned_connection_ids: adminPinnedConnectionIds,
    member_pinned_connection_ids: memberPinnedConnectionIds,
    org_default_connection_ids: orgDefaultConnectionIds,
    org_default_enforced: orgDefaultEnforced,
    can_add_connection: canConfigureIntegrations || !blocked,
    candidates,
  };
}

/** Bulk per-agent connection readiness — one call covering badge, picker, and pre-run check. */
interface AgentConnectionReadiness {
  /** True iff the run would be refused — an inactive agent, or a connection the resolver rejects. */
  blocks_run: boolean;
  /**
   * What blocks the run. The integration portion of the 412 envelope (same
   * `field: integrations.<id>` shape), plus `agent_not_active` when the SPACE
   * has switched the agent off: the three execution doors answer that with a
   * 404, and this read reports it instead, because a panel that 404s cannot
   * tell anyone what to fix.
   */
  errors: ValidationFieldError[];
  /** Every declared integration with its management verdict (includeInert) + run-blocking flag. */
  integrations: Array<{
    integration_id: string;
    run_blocking: boolean;
    resolution: IntegrationAgentResolution;
  }>;
}

/**
 * Bulk connection readiness for an agent. Resolves the manifest ONCE for the
 * requested version and runs each cascade once for the whole agent, so a page
 * load costs two cascades regardless of how many integrations are declared.
 *
 * `blocks_run` / `errors` come from `resolveConnectionsForRun` with the RUN
 * semantics (`includeInert: false` + the required-auth carve-out) — the exact
 * resolver call the run-kickoff 412 uses — so the UI's pre-run signal can never
 * disagree with the actual gate. The per-integration `resolution` DTOs come
 * from a second `includeInert: true` cascade over the same manifest, so every
 * declared integration, even an inert one, stays manageable in the Connexions
 * tab. Both are handed to the picks; nothing downstream re-reads the package.
 */
export async function resolveAgentConnectionReadiness(args: {
  scope: SpaceScope;
  agentPackageId: string;
  actor: Actor;
  canConfigureIntegrations: boolean;
  /**
   * Version selector (`draft` | `published` | concrete semver | dist-tag) —
   * REQUIRED, and the router's decision, not this service's. Who may name
   * `draft` is a question about the CALLER (`holdsPackageWriteAuthority`), which
   * a service taking a `SpaceScope` cannot answer — so any default computed
   * here would judge a definition the launch form and the run route do not
   * execute. The route decides once, with `defaultDefinitionSelector`, and
   * hands the answer over.
   */
  version: string;
}): Promise<AgentConnectionReadiness> {
  const { scope, agentPackageId, actor, canConfigureIntegrations, version } = args;
  const loaded = await getPackage(agentPackageId, scope.orgId);
  if (!loaded) throw notFound(`Agent '${agentPackageId}' not found in this organization`);
  // The SPACE's own switch, asked here and reported rather than thrown. The run
  // doors refuse a switched-off agent with `404 agent_not_active_in_space`
  // (`requireActiveAgent`); readiness is the panel that EXPLAINS a refusal, so
  // it answers 200 and carries the cause next to `integration_not_active`. The
  // rest of the readiness still resolves: an operator about to switch the agent
  // back on wants to know what ELSE is missing, in one pass.
  const agentActive = await isPackageActiveHere(scope, agentPackageId);
  const { agent } = await resolveAgentRunVersion(loaded, version);
  const agentManifest = agent.manifest as unknown as Record<string, unknown>;
  const declared = parseManifestIntegrations(agentManifest);

  // One memo shared by BOTH cascades and every per-integration pick below.
  // Without it each pick re-fetched every integration manifest, so an agent
  // declaring N integrations paid O(N²) manifest reads for one page load.
  const manifestCache: IntegrationManifestCache = new Map();

  // Seed that memo with each declared integration's PINNED manifest BEFORE
  // either cascade reads it — the same seeding the run performs at kickoff
  // (run-pipeline Step 2a / run-creation, both via
  // `freezeRunSpawnDependencies` → `resolveRunIntegrationVersions`). Unseeded,
  // `buildRequirement` falls through to `fetchIntegrationManifest`, which reads
  // `packages.draft_manifest`: the readiness verdict would then judge auth keys
  // and required scopes against the integration author's LIVE DRAFT while the
  // run-kickoff 412 judges them against the pinned published version — exactly
  // the disagreement this function's contract above forbids. (#1178 closed the
  // agent-manifest half of it; this is the integration-manifest half.)
  //
  // The result is deliberately ignored. An unsatisfiable pin is a
  // `dependency_unresolved` (422) the kickoff raises on its own, not a
  // connection verdict this endpoint can express; the ids it leaves unseeded
  // keep the pre-existing draft fallback rather than blanking the Connexions
  // tab. Every id that DID resolve is seeded either way.
  //
  // Independent of the `version` selector: that selector picks the AGENT
  // manifest, and a run of the draft agent still freezes its integration pins
  // against published versions. Seeding unconditionally is what keeps the two
  // aligned for `?version=draft` as well.
  await resolveRunIntegrationVersions({
    agentManifest,
    orgId: scope.orgId,
    manifestCache,
  });

  const userId = actor.type === "user" ? actor.id : null;

  // Two cascades, deliberately — they answer different questions over the SAME
  // resolved manifest. The run gate excludes inert integrations (and applies
  // the required-auth carve-out); the management DTO includes them so an inert
  // integration stays pinnable in the Connexions tab. Neither is derivable from
  // the other, but both are agent-level: one call each, not one per integration.
  const [runResolution, pickResolution, memberPins] = await Promise.all([
    resolveConnectionsForRun({
      agentManifest,
      packageId: agent.id,
      actor,
      scope: { orgId: scope.orgId, spaceId: scope.spaceId },
      manifestCache,
    }),
    resolveConnectionsForRun({
      agentManifest,
      packageId: agent.id,
      actor,
      scope: { orgId: scope.orgId, spaceId: scope.spaceId },
      includeInert: true,
      manifestCache,
    }),
    userId
      ? listMemberPinsForAgent(scope, agent.id, userId)
      : Promise.resolve([] as MemberPinSummary[]),
  ]);
  const blockingIds = new Set(runResolution.errors.map((e) => e.integrationId));

  const resolutions = await Promise.all(
    declared.map((e) =>
      resolveAgentIntegrationPick({
        scope,
        agentPackageId: agent.id,
        integrationId: e.id,
        actor,
        canConfigureIntegrations,
        agentManifest,
        resolution: pickResolution,
        memberPins,
        manifestCache,
      }),
    ),
  );

  const errors: ValidationFieldError[] = runResolution.errors.map(translateResolutionError);
  if (!agentActive) {
    // First in the list: every other entry describes something to configure,
    // and none of it can run while the space has the agent switched off.
    errors.unshift({
      field: "agent",
      code: "agent_not_active",
      title: "Agent Not Active",
      message: `Agent '${agent.id}' is not active in this space.`,
    });
  }

  return {
    blocks_run: errors.length > 0,
    errors,
    integrations: declared.map((e, i) => ({
      integration_id: e.id,
      run_blocking: blockingIds.has(e.id),
      resolution: resolutions[i]!,
    })),
  };
}
