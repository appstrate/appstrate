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
 * Same target validation as admin pins (`validatePinTarget` with
 * `requireShared`), for every connection of the set: it must exist, belong
 * to this space, reference this integration, and be `sharedWithOrg = true`
 * — an admin can't coerce a member's personal connection.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationOrgDefaults } from "@appstrate/db/schema";
import type { IntegrationOrgDefault } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import { assertDistinctConnectionLabels, validatePinTarget } from "./integration-pins-service.ts";

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
    .where(
      and(
        eq(integrationOrgDefaults.spaceId, scope.spaceId),
        eq(integrationOrgDefaults.integrationId, integrationId),
      ),
    )
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

/** Set or replace the org default set for (space, integration). */
export async function upsertOrgDefault(
  scope: SpaceScope,
  integrationId: string,
  input: UpsertOrgDefaultInput,
): Promise<OrgDefaultSummary> {
  const conns = await Promise.all(
    input.connectionIds.map((connectionId) =>
      validatePinTarget(scope, integrationId, connectionId, { requireShared: true }),
    ),
  );
  assertDistinctConnectionLabels(integrationId, conns);

  const now = new Date();
  // Atomic upsert on the (space, integration) unique index — avoids the
  // check-then-insert race where two concurrent first-writers both miss the
  // SELECT and the loser's INSERT throws a raw unique-violation (500).
  const [row] = await db
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
  return toSummary(row!);
}

export async function deleteOrgDefault(
  scope: SpaceScope,
  integrationId: string,
): Promise<{ deleted: boolean }> {
  const result = await db
    .delete(integrationOrgDefaults)
    .where(
      and(
        eq(integrationOrgDefaults.spaceId, scope.spaceId),
        eq(integrationOrgDefaults.integrationId, integrationId),
      ),
    )
    .returning({ id: integrationOrgDefaults.id });
  return { deleted: result.length > 0 };
}
