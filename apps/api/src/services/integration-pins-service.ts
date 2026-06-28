// SPDX-License-Identifier: Apache-2.0

/**
 * Service layer for `integration_pins` + the per-(app, integration)
 * `block_user_connections` toggle + connection metadata edits
 * (label, sharedWithOrg). Consumed by the routes in `routes/integrations.ts`.
 *
 * Pin model (flat): one pin per (application, agent, integration, scope).
 * Scope = admin (`user_id IS NULL`) OR member (`user_id = caller.id`).
 * The pin row carries a `connection_id`; the connection's own `auth_key`
 * is denormalised on the PinSummary for display but never part of the
 * uniqueness key — OAuth and api_key connections are interchangeable at
 * runtime.
 *
 * All admin-only operations — the route layer enforces
 * `requirePermission("integrations", "install")` plus an org admin/owner check
 * (`assertOrgAdmin` in `routes/integrations.ts`); this layer assumes the caller
 * already has the role.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, toRows } from "@appstrate/db/client";
import {
  applicationPackages,
  endUsers,
  integrationConnections,
  integrationPins,
  integrationOrgDefaults,
  packages,
  user,
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
  type ConnectionResolutionSource,
} from "@appstrate/core/integration";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { isSystemIntegration } from "./integration-client-registry.ts";
import { conflict, notFound, invalidRequest } from "../lib/errors.ts";
import type { AppScope } from "../lib/scope.ts";
import type { Actor } from "../lib/actor.ts";
import type { ValidationFieldError } from "../lib/errors.ts";
import { getPackage } from "./package-catalog.ts";
import { resolveAgentRunVersion } from "./agent-version-resolver.ts";
import { fetchIntegrationManifest } from "./integration-service.ts";
import { getOrgDefault } from "./integration-org-defaults-service.ts";
import {
  resolveConnectionsForRun,
  translateResolutionError,
  isUserConnectionCreationBlocked,
} from "./integration-connection-resolver.ts";

// Canonical wire shapes live in @appstrate/shared-types so the frontend
// hook and OpenAPI spec can't drift from the service. Local aliases keep
// the existing call sites readable.
export type PinSummary = IntegrationPin;
export type SharedConnectionSummary = AccessibleIntegrationConnection;
export type { ConsumingAgentSummary };

// ─────────────────────────── block_user_connections toggle ────────────────────

/**
 * Toggle the per-(application, integration) lock.
 *
 * An existing `application_packages` row is updated in place. With NO row, a
 * SYSTEM integration is auto-active without an explicit install (see
 * `isIntegrationActive`) — materialize the row so the toggle persists, rather
 * than 404ing the operator out of a setting they can legitimately reach.
 * `enabled` defaults to true on insert, so recording the block flag never
 * deactivates an auto-active integration. A genuinely-not-installed,
 * non-system integration still 404s (unchanged).
 */
export async function setBlockUserConnections(
  scope: AppScope,
  integrationId: string,
  blocked: boolean,
): Promise<{ blocked: boolean }> {
  const result = await db
    .update(applicationPackages)
    .set({ blockUserConnections: blocked, updatedAt: new Date() })
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, integrationId),
      ),
    )
    .returning({ blockUserConnections: applicationPackages.blockUserConnections });
  if (result.length > 0) {
    return { blocked: result[0]!.blockUserConnections };
  }
  // No row. Only a system integration is auto-active without one; anything else
  // is genuinely not installed.
  if (!isSystemIntegration(integrationId)) {
    throw notFound(`Integration '${integrationId}' is not installed in this application`);
  }
  const [inserted] = await db
    .insert(applicationPackages)
    .values({
      applicationId: scope.applicationId,
      packageId: integrationId,
      config: {},
      blockUserConnections: blocked,
    })
    .onConflictDoUpdate({
      target: [applicationPackages.applicationId, applicationPackages.packageId],
      set: { blockUserConnections: blocked, updatedAt: new Date() },
    })
    .returning({ blockUserConnections: applicationPackages.blockUserConnections });
  return { blocked: inserted!.blockUserConnections };
}

// ─────────────────────────── Pin CRUD ─────────────────────────────────────────

interface PinJoinRow {
  pin: PinRow;
  conn: ConnectionRow | null;
}

function toPinSummary(row: PinJoinRow): PinSummary {
  return {
    packageId: row.pin.packageId,
    integration_package_id: row.pin.integrationId,
    auth_key: row.conn?.authKey ?? "",
    connection_id: row.pin.connectionId,
    createdAt: row.pin.createdAt.toISOString(),
    updatedAt: row.pin.updatedAt.toISOString(),
  };
}

async function listPinsBy(conditions: Parameters<typeof and>): Promise<PinSummary[]> {
  const rows = await db
    .select({ pin: integrationPins, conn: integrationConnections })
    .from(integrationPins)
    .leftJoin(integrationConnections, eq(integrationConnections.id, integrationPins.connectionId))
    .where(and(...conditions));
  return rows.map(toPinSummary);
}

/**
 * List every admin pin governing a (app, integration). Used by the admin UI
 * to render the per-agent pin section + by the runtime resolver via the
 * dedicated `loadPins` helper (private to the resolver, see
 * integration-connection-resolver.ts).
 */
export async function listIntegrationPins(
  scope: AppScope,
  integrationId: string,
): Promise<PinSummary[]> {
  return listPinsBy([
    eq(integrationPins.applicationId, scope.applicationId),
    eq(integrationPins.integrationId, integrationId),
    isNull(integrationPins.userId),
  ]);
}

/**
 * R2 — agents installed in the application that declare the given integration
 * in their dependencies. Powers the centralised pin management table on the
 * integration detail page (so the admin can pick which installed agent to
 * pin without leaving the integration view).
 */
export async function listAgentsConsumingIntegration(
  scope: AppScope,
  integrationId: string,
): Promise<ConsumingAgentSummary[]> {
  const rows = toRows<{ package_id: string; display_name: string | null }>(
    await db.execute(sql`
      SELECT p.id AS package_id,
             p.draft_manifest->>'display_name' AS display_name
      FROM ${applicationPackages} ap
      INNER JOIN ${packages} p ON p.id = ap.package_id
      WHERE ap.application_id = ${scope.applicationId}
        AND p.type = 'agent'
        AND (p.draft_manifest -> 'dependencies' -> 'integrations') ? ${integrationId}
      ORDER BY p.id ASC
    `),
  );
  return rows.map((r) => ({
    packageId: r.package_id,
    display_name: r.display_name ?? r.package_id,
  }));
}

export interface SetPinInput {
  agentPackageId: string;
  connectionId: string;
  createdBy: string | null;
}

/**
 * Upsert an admin pin. Validates that the pinned connection:
 *   1. exists in the same application,
 *   2. references the integration this pin governs,
 *   3. is `sharedWithOrg=true` (pinning a personal connection would
 *      leak the admin's identity to other members at run time).
 *
 * Flat model: one pin per (app, agent, integration, admin-scope).
 * The connection carries its own authKey — pinning a PAT connection
 * overrides the agent's oauth-by-default just by virtue of being the
 * picked connection.
 */
export async function upsertIntegrationPin(
  scope: AppScope,
  integrationId: string,
  input: SetPinInput,
): Promise<PinSummary> {
  return upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId,
    connectionId: input.connectionId,
    userIdValue: null,
    validateOpts: { requireShared: true },
    createdBy: input.createdBy,
    updateCreatedBy: true,
  });
}

/**
 * Shared upsert for admin (`userId IS NULL`) and member (`userId = actor`)
 * pins. Both scopes select-then-update/insert on the same flat key
 * `(application, agent, integration, scope)`, differing only by the userId
 * predicate, the connection validation opts, and `createdBy`.
 */
async function upsertPin(args: {
  scope: AppScope;
  agentPackageId: string;
  integrationId: string;
  connectionId: string;
  userIdValue: string | null;
  validateOpts: { requireShared?: boolean; allowOwnedBy?: string };
  createdBy: string | null;
  /**
   * Whether to write `createdBy` on the UPDATE branch. Admin pins re-stamp
   * the admin who last set the pin; member pins leave it untouched on
   * update (the row's `createdBy` is the member, set once at insert).
   */
  updateCreatedBy: boolean;
}): Promise<PinSummary> {
  const { scope, agentPackageId, integrationId, connectionId, userIdValue, createdBy } = args;
  const conn = await validatePinTarget(scope, integrationId, connectionId, args.validateOpts);
  await assertAgentInstalled(scope, agentPackageId);

  const now = new Date();
  const userPredicate =
    userIdValue === null ? isNull(integrationPins.userId) : eq(integrationPins.userId, userIdValue);
  const [existing] = await db
    .select({ id: integrationPins.id })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.integrationId, integrationId),
        userPredicate,
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(integrationPins)
      .set({
        connectionId,
        updatedAt: now,
        ...(args.updateCreatedBy ? { createdBy } : {}),
      })
      .where(eq(integrationPins.id, existing.id));
  } else {
    await db.insert(integrationPins).values({
      applicationId: scope.applicationId,
      packageId: agentPackageId,
      integrationId,
      userId: userIdValue,
      connectionId,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    packageId: agentPackageId,
    integration_package_id: integrationId,
    auth_key: conn.authKey,
    connection_id: connectionId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteIntegrationPin(
  scope: AppScope,
  integrationId: string,
  agentPackageId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.integrationId, integrationId),
        eq(integrationPins.packageId, agentPackageId),
        isNull(integrationPins.userId),
      ),
    )
    .returning({ id: integrationPins.id });
  return { deleted: result.length > 0 };
}

async function assertAgentInstalled(scope: AppScope, agentPackageId: string): Promise<void> {
  const [row] = await db
    .select({ id: applicationPackages.packageId })
    .from(applicationPackages)
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, agentPackageId),
      ),
    )
    .limit(1);
  if (!row) throw notFound(`Agent '${agentPackageId}' is not installed in this application`);
}

export async function validatePinTarget(
  scope: AppScope,
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
  if (conn.applicationId !== scope.applicationId) {
    throw invalidRequest("Pinned connection belongs to a different application");
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

export interface UpsertMemberPinInput {
  agentPackageId: string;
  integrationId: string;
  connectionId: string;
  userId: string;
}

/**
 * Upsert a member-scope pin (`integration_pins` row with `user_id` set).
 *
 * Member writes their own preference for this (agent, integration) —
 * the persisted row the resolver sees on every run (layer 4 of the
 * cascade).
 */
export async function upsertMemberPin(
  scope: AppScope,
  input: UpsertMemberPinInput,
): Promise<PinSummary> {
  return upsertPin({
    scope,
    agentPackageId: input.agentPackageId,
    integrationId: input.integrationId,
    connectionId: input.connectionId,
    userIdValue: input.userId,
    validateOpts: { allowOwnedBy: input.userId },
    createdBy: input.userId,
    updateCreatedBy: false,
  });
}

export async function deleteMemberPin(
  scope: AppScope,
  agentPackageId: string,
  integrationId: string,
  userId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
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
 * renders the collapsed "Using: X" row pointing at the pinned connection.
 */
export interface MemberPinSummary {
  integration_package_id: string;
  connection_id: string;
}

export async function listMemberPinsForAgent(
  scope: AppScope,
  agentPackageId: string,
  userId: string,
): Promise<MemberPinSummary[]> {
  const rows = await db
    .select({
      integration_package_id: integrationPins.integrationId,
      connection_id: integrationPins.connectionId,
    })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.userId, userId),
      ),
    );
  return rows;
}

// ─────────────────────────── Connection metadata edits ────────────────────────

export interface UpdateConnectionMetadataInput {
  label?: string | null;
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

  const updates: { label?: string | null; sharedWithOrg?: boolean; updatedAt: Date } = {
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
  applicationId: string;
  userId: string | null;
  endUserId: string | null;
} | null> {
  const [row] = await db
    .select({
      applicationId: integrationConnections.applicationId,
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
 * (application, integration). Used by the UI picker:
 * own + shared, with caller-facing labels.
 */
export async function listAccessibleConnections(
  scope: AppScope,
  integrationId: string,
  actorFilter: { userId?: string; endUserId?: string },
): Promise<SharedConnectionSummary[]> {
  const baseConditions = [
    eq(integrationConnections.applicationId, scope.applicationId),
    eq(integrationConnections.integrationId, integrationId),
  ];

  const [own, shared] = await Promise.all([
    actorFilter.userId || actorFilter.endUserId
      ? db
          .select()
          .from(integrationConnections)
          .where(
            and(
              ...baseConditions,
              actorFilter.userId
                ? eq(integrationConnections.userId, actorFilter.userId)
                : eq(integrationConnections.endUserId, actorFilter.endUserId!),
            ),
          )
      : Promise.resolve([] as ConnectionRow[]),
    db
      .select()
      .from(integrationConnections)
      .where(and(...baseConditions, eq(integrationConnections.sharedWithOrg, true))),
  ]);
  const seen = new Set<string>();
  const merged: ConnectionRow[] = [];
  for (const r of [...own, ...shared]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return attachOwnerNames(merged);
}

/**
 * Resolve owner display names in two batched lookups (user + end_users)
 * and project the connection rows into picker summaries. Keeps the dual
 * own/shared query path untouched — names are a post-pass over whatever
 * rows survived the merge.
 */
async function attachOwnerNames(rows: ConnectionRow[]): Promise<SharedConnectionSummary[]> {
  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => v !== null))];
  const endUserIds = [
    ...new Set(rows.map((r) => r.endUserId).filter((v): v is string => v !== null)),
  ];

  const [userRows, endUserRows] = await Promise.all([
    userIds.length
      ? db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
      : Promise.resolve([] as { id: string; name: string }[]),
    endUserIds.length
      ? db
          .select({ id: endUsers.id, name: endUsers.name, externalId: endUsers.externalId })
          .from(endUsers)
          .where(inArray(endUsers.id, endUserIds))
      : Promise.resolve([] as { id: string; name: string | null; externalId: string | null }[]),
  ]);

  const userNames = new Map(userRows.map((u) => [u.id, u.name]));
  const endUserNames = new Map(endUserRows.map((e) => [e.id, e.name ?? e.externalId]));

  return rows.map((row) => ({
    id: row.id,
    auth_key: row.authKey,
    account_id: row.accountId,
    label: row.label,
    owner_user_id: row.userId,
    owner_end_user_id: row.endUserId,
    owner_name: row.userId
      ? (userNames.get(row.userId) ?? null)
      : row.endUserId
        ? (endUserNames.get(row.endUserId) ?? null)
        : null,
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
 */
export async function resolveAgentIntegrationPick(args: {
  scope: AppScope;
  agentPackageId: string;
  integrationId: string;
  actor: Actor;
  isAdmin: boolean;
}): Promise<IntegrationAgentResolution> {
  const { scope, agentPackageId, integrationId, actor, isAdmin } = args;

  const agent = await getPackage(agentPackageId, scope.orgId);
  if (!agent) throw notFound(`Agent '${agentPackageId}' not found in this organization`);
  const agentManifest = agent.manifest as unknown as Record<string, unknown>;
  const agentEntry = parseManifestIntegrations(agentManifest).find((e) => e.id === integrationId);
  // AFPS §4.4 — preserve the wildcard literal `"*"` so `missingScopesForConnection`
  // can route through the default-scopes branch of `requiredScopesForAgent`.
  // Coercing `"*"` to `[]` here would silently bypass the scope diff and let
  // a connection with zero default scopes appear "fully connected".
  const agentTools: readonly string[] | "*" = agentEntry?.tools ?? [];
  const agentScopes = agentEntry?.scopes ?? [];

  const manifestRes = await fetchIntegrationManifest(integrationId);
  const manifest = manifestRes.ok ? manifestRes.manifest : null;

  const actorFilter = actor.type === "user" ? { userId: actor.id } : { endUserId: actor.id };
  const userId = actor.type === "user" ? actor.id : null;

  const [candidatesRaw, adminPins, memberPins, blocked, orgDefault, resolution] = await Promise.all(
    [
      listAccessibleConnections(scope, integrationId, actorFilter),
      listIntegrationPins(scope, integrationId),
      userId
        ? listMemberPinsForAgent(scope, agentPackageId, userId)
        : Promise.resolve([] as MemberPinSummary[]),
      isUserConnectionCreationBlocked(scope.applicationId, integrationId),
      getOrgDefault(scope, integrationId),
      resolveConnectionsForRun({
        agentManifest,
        packageId: agentPackageId,
        actor,
        scope: { orgId: scope.orgId, applicationId: scope.applicationId },
        // The picker manages connections for EVERY declared integration, incl.
        // inert ones (auth_key but no tools/scopes). Opting in here makes the
        // cascade honour their pins too — so we reuse its verdict + `source`
        // rather than re-deriving the precedence in this service.
        includeInert: true,
      }),
    ],
  );

  const adminPinnedConnectionId =
    adminPins.find((p) => p.packageId === agentPackageId)?.connection_id ?? null;
  const memberPinnedConnectionId =
    memberPins.find((p) => p.integration_package_id === integrationId)?.connection_id ?? null;
  const orgDefaultConnectionId = orgDefault?.connection_id ?? null;
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
  let resolvedConnectionId: string | null = null;
  let resolvedMissingScopes: string[] = [];
  let resolvedOwnedByActor = false;

  if (resolved) {
    resolvedConnectionId = resolved.connectionId;
    status = pickStatusForSource(resolved.source);
    resolvedOwnedByActor = candidates.find((c) => c.id === resolved.connectionId)?.is_own ?? false;
  } else if (err) {
    switch (err.code) {
      case "insufficient_scopes":
        resolvedConnectionId = err.connectionId ?? null;
        resolvedMissingScopes = err.missingScopes ?? [];
        resolvedOwnedByActor = err.ownedByActor ?? false;
        status = err.source ? pickStatusForSource(err.source) : "auto";
        break;
      case "must_choose_connection":
        status = "must_choose";
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
    if (candidates.length === 1) resolvedConnectionId = candidates[0]!.id;
  }

  return {
    status,
    resolved_connection_id: resolvedConnectionId,
    resolved_missing_scopes: resolvedMissingScopes,
    resolved_owned_by_actor: resolvedOwnedByActor,
    admin_pinned_connection_id: adminPinnedConnectionId,
    member_pinned_connection_id: memberPinnedConnectionId,
    org_default_connection_id: orgDefaultConnectionId,
    org_default_enforced: orgDefaultEnforced,
    can_add_connection: isAdmin || !blocked,
    candidates,
  };
}

/** Bulk per-agent connection readiness — one call covering badge, picker, and pre-run check. */
export interface AgentConnectionReadiness {
  /** True iff the run-kickoff would reject with 412 (run semantics — identical authority). */
  blocks_run: boolean;
  /** The integration portion of the 412 envelope (same `field: integrations.<id>` shape). */
  errors: ValidationFieldError[];
  /** Every declared integration with its management verdict (includeInert) + run-blocking flag. */
  integrations: Array<{
    integration_id: string;
    run_blocking: boolean;
    resolution: IntegrationAgentResolution;
  }>;
}

/**
 * Bulk connection readiness for an agent. Replaces the N per-integration
 * `resolveAgentIntegrationPick` round-trips with a single agent-level call.
 *
 * `blocks_run` / `errors` come from `resolveConnectionsForRun` with the RUN
 * semantics (`includeInert: false` + the required-auth carve-out) — the exact
 * resolver call the run-kickoff 412 uses — so the UI's pre-run signal can never
 * disagree with the actual gate. The per-integration `resolution` DTOs use
 * `includeInert: true` (inside `resolveAgentIntegrationPick`) so every declared
 * integration, even an inert one, stays manageable in the Connexions tab.
 */
export async function resolveAgentConnectionReadiness(args: {
  scope: AppScope;
  agentPackageId: string;
  actor: Actor;
  isAdmin: boolean;
  /**
   * Version selector (`draft` | `published` | concrete semver | dist-tag).
   * Omitted ⇒ `draft` — preserves the launch-badge default. Any other value
   * resolves the same manifest the run would execute (issue #770), so the
   * readiness verdict matches the run for a pinned version, not the draft.
   */
  version?: string;
}): Promise<AgentConnectionReadiness> {
  const { scope, agentPackageId, actor, isAdmin, version } = args;
  const loaded = await getPackage(agentPackageId, scope.orgId);
  if (!loaded) throw notFound(`Agent '${agentPackageId}' not found in this organization`);
  // Resolve the effective definition for the selected version. `draft`/omitted
  // short-circuits to the draft `LoadedPackage` untouched; a concrete version
  // substitutes the published manifest via the same resolver the run uses.
  const { agent } = await resolveAgentRunVersion(loaded, version ?? "draft");
  const agentManifest = agent.manifest as unknown as Record<string, unknown>;
  const declared = parseManifestIntegrations(agentManifest);

  // Authoritative run-blocking verdict — the same resolver call the run gate runs.
  const runResolution = await resolveConnectionsForRun({
    agentManifest,
    packageId: agent.id,
    actor,
    scope: { orgId: scope.orgId, applicationId: scope.applicationId },
  });
  const blockingIds = new Set(runResolution.errors.map((e) => e.integrationId));

  // Per-integration management DTO (includeInert:true inside the pick).
  const resolutions = await Promise.all(
    declared.map((e) =>
      resolveAgentIntegrationPick({
        scope,
        agentPackageId: agent.id,
        integrationId: e.id,
        actor,
        isAdmin,
      }),
    ),
  );

  return {
    blocks_run: runResolution.errors.length > 0,
    errors: runResolution.errors.map(translateResolutionError),
    integrations: declared.map((e, i) => ({
      integration_id: e.id,
      run_blocking: blockingIds.has(e.id),
      resolution: resolutions[i]!,
    })),
  };
}
