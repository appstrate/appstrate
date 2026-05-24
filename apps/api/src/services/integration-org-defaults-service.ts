// SPDX-License-Identifier: Apache-2.0

/**
 * Org-wide default connection per (application, integration) — admin CRUD +
 * the resolver-facing aggregator.
 *
 * The default is the cross-agent governance baseline: one row covers every
 * agent that consumes the integration, instead of one `integration_pins`
 * row per agent. `enforce` discriminates strength (see the table doc in
 * `packages/db/src/schema/integration-org-defaults.ts` and the resolver
 * cascade in `integration-connection-resolver.ts`).
 *
 * Same target validation as admin pins (`validatePinTarget` with
 * `requireShared`): the connection must exist, belong to this application,
 * reference this integration, and be `sharedWithOrg = true` — an admin
 * can't coerce a member's personal connection.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationOrgDefaults } from "@appstrate/db/schema";
import type { AppScope } from "../lib/scope.ts";
import { validatePinTarget } from "./integration-pins-service.ts";

export interface OrgDefaultSummary {
  integrationPackageId: string;
  connectionId: string;
  /** The default connection's own authKey — surfaced for UI parity with pins. */
  authKey: string;
  enforce: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertOrgDefaultInput {
  connectionId: string;
  enforce: boolean;
  createdBy: string | null;
}

/** The org default for (application, integration), or null when unset. */
export async function getOrgDefault(
  scope: AppScope,
  integrationPackageId: string,
): Promise<OrgDefaultSummary | null> {
  const [row] = await db
    .select({
      connectionId: integrationOrgDefaults.connectionId,
      enforce: integrationOrgDefaults.enforce,
      createdAt: integrationOrgDefaults.createdAt,
      updatedAt: integrationOrgDefaults.updatedAt,
      authKey: integrationConnections.authKey,
    })
    .from(integrationOrgDefaults)
    .innerJoin(
      integrationConnections,
      eq(integrationOrgDefaults.connectionId, integrationConnections.id),
    )
    .where(
      and(
        eq(integrationOrgDefaults.applicationId, scope.applicationId),
        eq(integrationOrgDefaults.integrationPackageId, integrationPackageId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    integrationPackageId,
    connectionId: row.connectionId,
    authKey: row.authKey,
    enforce: row.enforce,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolver-facing map for one application: integrationId → {connectionId,
 * enforce}. Loaded alongside pins in `resolveConnectionsForRun`.
 */
export async function listOrgDefaultsForResolver(
  applicationId: string,
): Promise<Record<string, { connectionId: string; enforce: boolean }>> {
  const rows = await db
    .select({
      integrationPackageId: integrationOrgDefaults.integrationPackageId,
      connectionId: integrationOrgDefaults.connectionId,
      enforce: integrationOrgDefaults.enforce,
    })
    .from(integrationOrgDefaults)
    .where(eq(integrationOrgDefaults.applicationId, applicationId));
  const out: Record<string, { connectionId: string; enforce: boolean }> = {};
  for (const r of rows)
    out[r.integrationPackageId] = { connectionId: r.connectionId, enforce: r.enforce };
  return out;
}

/** Set or replace the org default for (application, integration). */
export async function upsertOrgDefault(
  scope: AppScope,
  integrationPackageId: string,
  input: UpsertOrgDefaultInput,
): Promise<OrgDefaultSummary> {
  const conn = await validatePinTarget(scope, integrationPackageId, input.connectionId, {
    requireShared: true,
  });

  const now = new Date();
  // Atomic upsert on the (application, integration) unique index — avoids the
  // check-then-insert race where two concurrent first-writers both miss the
  // SELECT and the loser's INSERT throws a raw unique-violation (500).
  await db
    .insert(integrationOrgDefaults)
    .values({
      applicationId: scope.applicationId,
      integrationPackageId,
      connectionId: input.connectionId,
      enforce: input.enforce,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [integrationOrgDefaults.applicationId, integrationOrgDefaults.integrationPackageId],
      set: {
        connectionId: input.connectionId,
        enforce: input.enforce,
        createdBy: input.createdBy,
        updatedAt: now,
      },
    });

  return {
    integrationPackageId,
    connectionId: input.connectionId,
    authKey: conn.authKey,
    enforce: input.enforce,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export async function deleteOrgDefault(
  scope: AppScope,
  integrationPackageId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationOrgDefaults)
    .where(
      and(
        eq(integrationOrgDefaults.applicationId, scope.applicationId),
        eq(integrationOrgDefaults.integrationPackageId, integrationPackageId),
      ),
    )
    .returning({ id: integrationOrgDefaults.id });
  return { deleted: result.length > 0 };
}
