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
 * All admin-only operations — the route layer enforces `requireAdmin()`,
 * this layer assumes the caller already has the role.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  endUsers,
  integrationConnections,
  integrationPins,
  packages,
  user,
} from "@appstrate/db/schema";
import type { InferSelectModel } from "drizzle-orm";
import { conflict, notFound, invalidRequest } from "../lib/errors.ts";
import type { AppScope } from "../lib/scope.ts";

type PinRow = InferSelectModel<typeof integrationPins>;
type ConnectionRow = InferSelectModel<typeof integrationConnections>;

// ─────────────────────────── block_user_connections toggle ────────────────────

/**
 * Toggle the per-(application, integration) lock. Refuses if the
 * application_packages row doesn't exist (integration not installed in
 * this app). Use after `assertIntegrationInstalled` to surface the
 * standard 404 instead.
 */
export async function setBlockUserConnections(
  scope: AppScope,
  integrationPackageId: string,
  blocked: boolean,
): Promise<{ blocked: boolean }> {
  const result = await db
    .update(applicationPackages)
    .set({ blockUserConnections: blocked, updatedAt: new Date() })
    .where(
      and(
        eq(applicationPackages.applicationId, scope.applicationId),
        eq(applicationPackages.packageId, integrationPackageId),
      ),
    )
    .returning({ blockUserConnections: applicationPackages.blockUserConnections });
  if (result.length === 0) {
    throw notFound(`Integration '${integrationPackageId}' is not installed in this application`);
  }
  return { blocked: result[0]!.blockUserConnections };
}

// ─────────────────────────── Pin CRUD ─────────────────────────────────────────

export interface PinSummary {
  packageId: string;
  integrationPackageId: string;
  /** Denormalised from the pinned connection — display hint only. */
  authKey: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
}

interface PinJoinRow {
  pin: PinRow;
  conn: ConnectionRow | null;
}

function toPinSummary(row: PinJoinRow): PinSummary {
  return {
    packageId: row.pin.packageId,
    integrationPackageId: row.pin.integrationPackageId,
    authKey: row.conn?.authKey ?? "",
    connectionId: row.pin.connectionId,
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
  integrationPackageId: string,
): Promise<PinSummary[]> {
  return listPinsBy([
    eq(integrationPins.applicationId, scope.applicationId),
    eq(integrationPins.integrationPackageId, integrationPackageId),
    isNull(integrationPins.userId),
  ]);
}

/**
 * R2 — agents installed in the application that declare the given integration
 * in their dependencies. Powers the centralised pin management table on the
 * integration detail page (so the admin can pick which installed agent to
 * pin without leaving the integration view).
 */
export interface ConsumingAgentSummary {
  packageId: string;
  displayName: string;
}

export async function listAgentsConsumingIntegration(
  scope: AppScope,
  integrationPackageId: string,
): Promise<ConsumingAgentSummary[]> {
  const rows = await db.execute(sql`
    SELECT p.id AS package_id,
           p.draft_manifest->>'displayName' AS display_name_alt,
           p.draft_manifest->'definition'->>'displayName' AS display_name_def
    FROM ${applicationPackages} ap
    INNER JOIN ${packages} p ON p.id = ap.package_id
    WHERE ap.application_id = ${scope.applicationId}
      AND p.type = 'agent'
      AND (p.draft_manifest -> 'dependencies' -> 'integrations') ? ${integrationPackageId}
    ORDER BY p.id ASC
  `);
  return (
    rows as unknown as {
      package_id: string;
      display_name_alt: string | null;
      display_name_def: string | null;
    }[]
  ).map((r) => ({
    packageId: r.package_id,
    displayName: r.display_name_def ?? r.display_name_alt ?? r.package_id,
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
  integrationPackageId: string,
  input: SetPinInput,
): Promise<PinSummary> {
  const conn = await validatePinTarget(scope, integrationPackageId, input.connectionId, {
    requireShared: true,
  });
  await assertAgentInstalled(scope, input.agentPackageId);

  const now = new Date();
  const [existing] = await db
    .select({ id: integrationPins.id })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.packageId, input.agentPackageId),
        eq(integrationPins.integrationPackageId, integrationPackageId),
        isNull(integrationPins.userId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(integrationPins)
      .set({ connectionId: input.connectionId, createdBy: input.createdBy, updatedAt: now })
      .where(eq(integrationPins.id, existing.id));
  } else {
    await db.insert(integrationPins).values({
      applicationId: scope.applicationId,
      packageId: input.agentPackageId,
      integrationPackageId,
      userId: null,
      connectionId: input.connectionId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    packageId: input.agentPackageId,
    integrationPackageId,
    authKey: conn.authKey,
    connectionId: input.connectionId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteIntegrationPin(
  scope: AppScope,
  integrationPackageId: string,
  agentPackageId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.integrationPackageId, integrationPackageId),
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

async function validatePinTarget(
  scope: AppScope,
  integrationPackageId: string,
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
  if (conn.integrationPackageId !== integrationPackageId) {
    throw invalidRequest(
      `Pinned connection belongs to integration '${conn.integrationPackageId}', not '${integrationPackageId}'`,
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
  integrationPackageId: string;
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
  const conn = await validatePinTarget(scope, input.integrationPackageId, input.connectionId, {
    allowOwnedBy: input.userId,
  });
  await assertAgentInstalled(scope, input.agentPackageId);

  const now = new Date();
  const [existing] = await db
    .select({ id: integrationPins.id })
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.packageId, input.agentPackageId),
        eq(integrationPins.integrationPackageId, input.integrationPackageId),
        eq(integrationPins.userId, input.userId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(integrationPins)
      .set({ connectionId: input.connectionId, updatedAt: now })
      .where(eq(integrationPins.id, existing.id));
  } else {
    await db.insert(integrationPins).values({
      applicationId: scope.applicationId,
      packageId: input.agentPackageId,
      integrationPackageId: input.integrationPackageId,
      userId: input.userId,
      connectionId: input.connectionId,
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    packageId: input.agentPackageId,
    integrationPackageId: input.integrationPackageId,
    authKey: conn.authKey,
    connectionId: input.connectionId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteMemberPin(
  scope: AppScope,
  agentPackageId: string,
  integrationPackageId: string,
  userId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.integrationPackageId, integrationPackageId),
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
  integrationPackageId: string;
  connectionId: string;
}

export async function listMemberPinsForAgent(
  scope: AppScope,
  agentPackageId: string,
  userId: string,
): Promise<MemberPinSummary[]> {
  const rows = await db
    .select({
      integrationPackageId: integrationPins.integrationPackageId,
      connectionId: integrationPins.connectionId,
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
    const pins = await db
      .select({ packageId: integrationPins.packageId })
      .from(integrationPins)
      .where(eq(integrationPins.connectionId, connectionId))
      .limit(1);
    if (pins.length > 0) {
      throw conflict(
        "connection_pinned",
        `Connection cannot be unshared while it is pinned to ${pins.length} agent(s). Remove the pin(s) first.`,
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

export interface SharedConnectionSummary {
  id: string;
  authKey: string;
  accountId: string;
  label: string | null;
  ownerUserId: string | null;
  ownerEndUserId: string | null;
  /**
   * Display name of whoever created the connection — dashboard user name
   * (Better Auth `user.name`) or end-user `name`/`externalId`. Null when
   * the owner row was deleted. Drives the "who connected it" line in the
   * agent-page picker so a member can tell a shared connection apart.
   */
  ownerName: string | null;
  /**
   * OAuth scopes currently granted to this connection. Empty for
   * api_key/basic auths. The agent-page picker diffs these against the
   * scopes the agent's selected tools require to flag under-scoped
   * connections before run-kickoff.
   */
  scopesGranted: string[];
  sharedWithOrg: boolean;
  needsReconnection: boolean;
}

/**
 * List the connections an actor can pick from for a given
 * (application, integration). Used by the UI picker:
 * own + shared, with caller-facing labels.
 */
export async function listAccessibleConnections(
  scope: AppScope,
  integrationPackageId: string,
  actorFilter?: { userId?: string; endUserId?: string },
): Promise<SharedConnectionSummary[]> {
  const baseConditions = [
    eq(integrationConnections.applicationId, scope.applicationId),
    eq(integrationConnections.integrationPackageId, integrationPackageId),
  ];

  if (actorFilter) {
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

  const rows = await db
    .select()
    .from(integrationConnections)
    .where(and(...baseConditions));
  return attachOwnerNames(rows);
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
    authKey: row.authKey,
    accountId: row.accountId,
    label: row.label,
    ownerUserId: row.userId,
    ownerEndUserId: row.endUserId,
    ownerName: row.userId
      ? (userNames.get(row.userId) ?? null)
      : row.endUserId
        ? (endUserNames.get(row.endUserId) ?? null)
        : null,
    scopesGranted: row.scopesGranted ?? [],
    sharedWithOrg: row.sharedWithOrg,
    needsReconnection: row.needsReconnection,
  }));
}
