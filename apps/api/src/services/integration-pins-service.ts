// SPDX-License-Identifier: Apache-2.0

/**
 * Service layer for `integration_pins` + the per-(app, integration)
 * `block_user_connections` toggle + connection metadata edits
 * (label, sharedWithOrg). Consumed by the routes in `routes/integrations.ts`.
 *
 * All admin-only operations — the route layer enforces `requireAdmin()`,
 * this layer assumes the caller already has the role.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import {
  applicationPackages,
  integrationConnections,
  integrationPins,
  packages,
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
  authKey: string;
  connectionId: string;
  createdAt: string;
  updatedAt: string;
}

function toPinSummary(row: PinRow): PinSummary {
  return {
    packageId: row.packageId,
    integrationPackageId: row.integrationPackageId,
    authKey: row.authKey,
    connectionId: row.connectionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * List every pin governing a (app, integration). Used by the admin UI
 * to render the per-agent pin section + by the runtime resolver via the
 * dedicated `loadPins` helper (private to the resolver, see
 * integration-connection-resolver.ts).
 */
export async function listIntegrationPins(
  scope: AppScope,
  integrationPackageId: string,
): Promise<PinSummary[]> {
  const rows = await db
    .select()
    .from(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.integrationPackageId, integrationPackageId),
      ),
    );
  return rows.map(toPinSummary);
}

export interface SetPinInput {
  agentPackageId: string;
  authKey: string;
  connectionId: string;
  createdBy: string | null;
}

/**
 * Upsert a pin. Validates that the pinned connection:
 *   1. exists in the same application,
 *   2. references the integration this pin governs,
 *   3. is on the matching authKey,
 *   4. is accessible to members — i.e. either admin-shared
 *      (sharedWithOrg=true) OR owned by an end-user shared with org
 *      (currently we accept any shared row; in p3b we may want to
 *      enforce shared-or-admin-owned more strictly).
 *
 * Refuses pinning a personal user connection that isn't shared —
 * pinning member A's private connection for everyone would silently
 * leak A's identity to other members at run time.
 */
export async function upsertIntegrationPin(
  scope: AppScope,
  integrationPackageId: string,
  input: SetPinInput,
): Promise<PinSummary> {
  // 1-3: validate the connection matches the pin target.
  const [conn] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, input.connectionId))
    .limit(1);
  if (!conn) throw notFound(`Connection '${input.connectionId}' not found`);
  if (conn.applicationId !== scope.applicationId) {
    throw invalidRequest("Pinned connection belongs to a different application");
  }
  if (conn.integrationPackageId !== integrationPackageId) {
    throw invalidRequest(
      `Pinned connection belongs to integration '${conn.integrationPackageId}', not '${integrationPackageId}'`,
    );
  }
  if (conn.authKey !== input.authKey) {
    throw invalidRequest(`Pinned connection has authKey '${conn.authKey}', not '${input.authKey}'`);
  }
  // 4: must be sharedWithOrg=true (own connections of the pinning
  // admin still need to be marked shared explicitly — keeps the share
  // toggle as the single explicit-consent gate).
  if (!conn.sharedWithOrg) {
    throw invalidRequest(
      "Pinned connection must be marked sharedWithOrg=true before it can be pinned for other members",
    );
  }

  // 5: validate the agent exists in the application.
  await assertAgentInstalled(scope, input.agentPackageId);

  const now = new Date();
  await db
    .insert(integrationPins)
    .values({
      applicationId: scope.applicationId,
      packageId: input.agentPackageId,
      integrationPackageId,
      authKey: input.authKey,
      connectionId: input.connectionId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        integrationPins.applicationId,
        integrationPins.packageId,
        integrationPins.integrationPackageId,
        integrationPins.authKey,
      ],
      set: {
        connectionId: input.connectionId,
        createdBy: input.createdBy,
        updatedAt: now,
      },
    });

  return {
    packageId: input.agentPackageId,
    integrationPackageId,
    authKey: input.authKey,
    connectionId: input.connectionId,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteIntegrationPin(
  scope: AppScope,
  integrationPackageId: string,
  agentPackageId: string,
  authKey: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationPins)
    .where(
      and(
        eq(integrationPins.applicationId, scope.applicationId),
        eq(integrationPins.integrationPackageId, integrationPackageId),
        eq(integrationPins.packageId, agentPackageId),
        eq(integrationPins.authKey, authKey),
      ),
    )
    .returning({ packageId: integrationPins.packageId });
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
      .select({ packageId: integrationPins.packageId, authKey: integrationPins.authKey })
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
  sharedWithOrg: boolean;
  needsReconnection: boolean;
}

/**
 * List the connections an actor can pick from for a given
 * (application, integration). Used by the UI picker that lands in p4:
 * own + shared, with caller-facing labels.
 */
export async function listAccessibleConnections(
  scope: AppScope,
  integrationPackageId: string,
  actorFilter?: { userId?: string; endUserId?: string },
): Promise<SharedConnectionSummary[]> {
  const conditions = [
    eq(integrationConnections.applicationId, scope.applicationId),
    eq(integrationConnections.integrationPackageId, integrationPackageId),
  ];

  // No actor filter = admin view (everything visible).
  // Actor filter = own + shared.
  if (actorFilter) {
    // Express as `(actor matches own) OR sharedWithOrg=true` — both via SQL.
    // Drizzle's `or` would simplify; we use IN-list here because actorFilter
    // has at most one of {userId, endUserId} populated.
    const ownerIds: string[] = [];
    if (actorFilter.userId) ownerIds.push(actorFilter.userId);
    if (actorFilter.endUserId) ownerIds.push(actorFilter.endUserId);
    // To avoid OR composition complexity, just do two queries and merge.
    const [own, shared] = await Promise.all([
      ownerIds.length > 0
        ? db
            .select()
            .from(integrationConnections)
            .where(
              and(
                eq(integrationConnections.applicationId, scope.applicationId),
                eq(integrationConnections.integrationPackageId, integrationPackageId),
                actorFilter.userId
                  ? eq(integrationConnections.userId, actorFilter.userId)
                  : eq(integrationConnections.endUserId, actorFilter.endUserId!),
              ),
            )
        : Promise.resolve([] as ConnectionRow[]),
      db
        .select()
        .from(integrationConnections)
        .where(
          and(
            eq(integrationConnections.applicationId, scope.applicationId),
            eq(integrationConnections.integrationPackageId, integrationPackageId),
            eq(integrationConnections.sharedWithOrg, true),
          ),
        ),
    ]);
    const seen = new Set<string>();
    const merged: ConnectionRow[] = [];
    for (const r of [...own, ...shared]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    return merged.map(toSummary);
  }

  const rows = await db
    .select()
    .from(integrationConnections)
    .where(and(...conditions));
  return rows.map(toSummary);
}

function toSummary(row: ConnectionRow): SharedConnectionSummary {
  return {
    id: row.id,
    authKey: row.authKey,
    accountId: row.accountId,
    label: row.label,
    ownerUserId: row.userId,
    ownerEndUserId: row.endUserId,
    sharedWithOrg: row.sharedWithOrg,
    needsReconnection: row.needsReconnection,
  };
}

// `packages` import is currently unused but retained — `listIntegrationPins`
// will gain agent-display-name enrichment in p5 (JOIN against packages.manifest
// for the dropdown). Removing for now to satisfy unused-import lint.
void packages;
void inArray;
