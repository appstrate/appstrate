// SPDX-License-Identifier: Apache-2.0

/**
 * Org-wide default connection set per (space, integration) — admin CRUD +
 * the resolver-facing aggregator.
 *
 * The default is the cross-agent governance baseline: one row covers every
 * agent that consumes the integration, instead of one `integration_pins`
 * row per agent. `enforce` discriminates strength (see the table doc in
 * `packages/db/src/schema/integration-org-defaults.ts` and the resolver
 * cascade in `integration-connection-resolver.ts`).
 *
 * Same target validation as admin pins (`validatePinTargets`, shared-only):
 * the connection must exist, belong to this space,
 * reference this integration, and be `sharedWithOrg = true` — an admin
 * can't coerce a member's personal connection.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationOrgDefaults } from "@appstrate/db/schema";
import type { IntegrationOrgDefault } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import { validatePinTargets } from "./integration-pins-service.ts";

/** Identical wire shape to {@link IntegrationOrgDefault}; aliased for the canonical pattern (cf. `PinSummary`). */
type OrgDefaultSummary = IntegrationOrgDefault;

export interface OrgDefaultPick {
  connectionIds: string[];
  enforce: boolean;
}

interface UpsertOrgDefaultInput {
  connectionIds: string[];
  enforce: boolean;
  createdBy: string | null;
}

function toSummary(row: typeof integrationOrgDefaults.$inferSelect): OrgDefaultSummary {
  return {
    integration_package_id: row.integrationId,
    connection_ids: row.connectionIds,
    enforce: row.enforce,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The org default for (space, integration), or null when unset. */
export async function getOrgDefault(
  scope: SpaceScope,
  integrationId: string,
): Promise<OrgDefaultSummary | null> {
  const [row] = await db
    .select()
    .from(integrationOrgDefaults)
    .where(orgDefaultKey(scope, integrationId))
    .limit(1);
  return row ? toSummary(row) : null;
}

/**
 * Resolver-facing map for one space: integrationId → {connectionIds,
 * enforce}. Loaded alongside pins in `resolveConnectionsForRun`.
 */
export async function listOrgDefaultsForResolver(
  spaceId: string,
): Promise<Record<string, OrgDefaultPick>> {
  const rows = await db
    .select({
      integrationId: integrationOrgDefaults.integrationId,
      connectionIds: integrationOrgDefaults.connectionIds,
      enforce: integrationOrgDefaults.enforce,
    })
    .from(integrationOrgDefaults)
    .where(eq(integrationOrgDefaults.spaceId, spaceId));
  return Object.fromEntries(
    rows.map((r) => [r.integrationId, { connectionIds: r.connectionIds, enforce: r.enforce }]),
  );
}

function orgDefaultKey(scope: SpaceScope, integrationId: string) {
  return and(
    eq(integrationOrgDefaults.spaceId, scope.spaceId),
    eq(integrationOrgDefaults.integrationId, integrationId),
  );
}

/**
 * Set or replace the org default for (space, integration). `previous` is the
 * default it replaced, read in the same transaction under a lock on the key —
 * the row lock alone locks nothing while no default exists yet.
 */
export async function upsertOrgDefault(
  scope: SpaceScope,
  integrationId: string,
  input: UpsertOrgDefaultInput,
): Promise<{ previous: OrgDefaultSummary | null; orgDefault: OrgDefaultSummary }> {
  await validatePinTargets(scope, integrationId, input.connectionIds);
  const now = new Date();
  return db.transaction(async (tx) => {
    const key = `integration-org-default:${scope.spaceId}:${integrationId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`);
    const [previous] = await tx
      .select()
      .from(integrationOrgDefaults)
      .where(orgDefaultKey(scope, integrationId))
      .for("update");
    // Atomic upsert on the (space, integration) unique index: two concurrent first writers cannot
    // both miss the SELECT and have the loser's INSERT throw a raw unique violation.
    const [row] = await tx
      .insert(integrationOrgDefaults)
      .values({
        spaceId: scope.spaceId,
        integrationId,
        connectionIds: input.connectionIds,
        enforce: input.enforce,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [integrationOrgDefaults.spaceId, integrationOrgDefaults.integrationId],
        set: {
          connectionIds: input.connectionIds,
          enforce: input.enforce,
          createdBy: input.createdBy,
          updatedAt: now,
        },
      })
      .returning();
    return { previous: previous ? toSummary(previous) : null, orgDefault: toSummary(row!) };
  });
}

/** Delete the org default; `previous` is the one removed, `null` when none was set. */
export async function deleteOrgDefault(
  scope: SpaceScope,
  integrationId: string,
): Promise<{ previous: OrgDefaultSummary | null }> {
  const [row] = await db
    .delete(integrationOrgDefaults)
    .where(orgDefaultKey(scope, integrationId))
    .returning();
  return { previous: row ? toSummary(row) : null };
}
