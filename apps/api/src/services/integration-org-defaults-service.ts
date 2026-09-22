// SPDX-License-Identifier: Apache-2.0

/**
 * Org-wide default connection SET per (space, integration) — admin CRUD +
 * the resolver-facing aggregator.
 *
 * The default is the cross-agent governance baseline: one set covers every
 * agent that consumes the integration, instead of one `integration_pins`
 * set per agent. `enforce` discriminates strength (see the table doc in
 * `packages/db/src/schema/integration-org-defaults.ts` and the resolver
 * cascade in `integration-connection-resolver.ts`).
 *
 * Same target validation as admin pins (`validatePinTarget` with
 * `requireShared`), applied to EVERY member.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { integrationConnections, integrationOrgDefaults } from "@appstrate/db/schema";
import type { IntegrationOrgDefault } from "@appstrate/shared-types";
import type { SpaceScope } from "../lib/scope.ts";
import {
  assertDistinctConnectionLabels,
  canonicalConnectionSet,
  validatePinTarget,
} from "./integration-pins-service.ts";

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

/** The org default for (space, integration), or null when unset. */
export async function getOrgDefault(
  scope: SpaceScope,
  integrationId: string,
): Promise<OrgDefaultSummary | null> {
  const rows = await db
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
        eq(integrationOrgDefaults.spaceId, scope.spaceId),
        eq(integrationOrgDefaults.integrationId, integrationId),
      ),
    )
    .orderBy(integrationOrgDefaults.connectionId);
  if (rows.length === 0) return null;
  const first = rows[0]!;
  return {
    integration_package_id: integrationId,
    connection_ids: rows.map((r) => r.connectionId),
    auth_key: first.authKey,
    enforce: first.enforce,
    createdAt: first.createdAt.toISOString(),
    updatedAt: first.updatedAt.toISOString(),
  };
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
      connectionId: integrationOrgDefaults.connectionId,
      enforce: integrationOrgDefaults.enforce,
    })
    .from(integrationOrgDefaults)
    .where(eq(integrationOrgDefaults.spaceId, spaceId))
    .orderBy(integrationOrgDefaults.connectionId);
  const out: Record<string, OrgDefaultPick> = {};
  for (const r of rows) {
    const pick = out[r.integrationId];
    if (pick) pick.connectionIds.push(r.connectionId);
    else out[r.integrationId] = { connectionIds: [r.connectionId], enforce: r.enforce };
  }
  return out;
}

/**
 * Replace the org default set. Delete-then-insert in ONE transaction: a member
 * the caller dropped must disappear with the write that adds the new ones.
 */
export async function upsertOrgDefault(
  scope: SpaceScope,
  integrationId: string,
  input: UpsertOrgDefaultInput,
  opts?: { onBeforeCommit?: () => Promise<void> },
): Promise<OrgDefaultSummary> {
  const connectionIds = canonicalConnectionSet(input.connectionIds, "connection_ids");
  const conns = await Promise.all(
    connectionIds.map((connectionId) =>
      validatePinTarget(scope, integrationId, connectionId, { requireShared: true }),
    ),
  );
  assertDistinctConnectionLabels(integrationId, conns);

  const now = new Date();
  const lockKey = `iod_set:${scope.spaceId}:${integrationId}`;
  await db.transaction(async (tx) => {
    // Without it two concurrent PUTs leave the union of their sets behind,
    // with both `enforce` values mixed across rows the resolver reads as one.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`);
    await tx
      .delete(integrationOrgDefaults)
      .where(
        and(
          eq(integrationOrgDefaults.spaceId, scope.spaceId),
          eq(integrationOrgDefaults.integrationId, integrationId),
        ),
      );
    await tx.insert(integrationOrgDefaults).values(
      connectionIds.map((connectionId) => ({
        spaceId: scope.spaceId,
        integrationId,
        connectionId,
        enforce: input.enforce,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })),
    );
    if (opts?.onBeforeCommit) await opts.onBeforeCommit();
  });

  return {
    integration_package_id: integrationId,
    connection_ids: connectionIds,
    auth_key: conns[0]!.authKey,
    enforce: input.enforce,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
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
