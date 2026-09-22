// SPDX-License-Identifier: Apache-2.0

/**
 * Org-wide default connection SET per (space, integration) — admin CRUD +
 * the resolver-facing aggregator.
 *
 * The default is the cross-agent governance baseline: one set covers every
 * agent that consumes the integration, instead of one `integration_pins`
 * set per agent. `enforce` discriminates strength (see the table doc in
 * `packages/db/src/schema/integration-org-defaults.ts` and the resolver
 * cascade in `integration-connection-resolver.ts`); the N rows of one
 * default share it by construction, because a write replaces the whole set.
 *
 * Same target validation as admin pins (`validatePinTarget` with
 * `requireShared`), applied to EVERY member: each connection must exist,
 * belong to this space, reference this integration, and be
 * `sharedWithOrg = true` — an admin can't coerce a member's personal
 * connection.
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

/** One space's default for one integration, as the resolver's layers 2 and 6 read it. */
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
    // Display hints derived from the set's first row: a set whose members sit
    // on different auths is legal (a PAT and an OAuth account of the same
    // provider), and the surface that needs per-connection auth reads the
    // connection list, not this summary.
    auth_key: first.authKey,
    enforce: first.enforce,
    createdAt: first.createdAt.toISOString(),
    updatedAt: first.updatedAt.toISOString(),
  };
}

/**
 * Resolver-facing map for one space: integrationId → {connectionIds,
 * enforce}. Loaded alongside pins in `resolveConnectionsForRun`.
 *
 * Ordered by `connection_id` for the same reason the pin readers are: the N
 * rows of one default are written in one transaction under one timestamp, so
 * only the id gives a stable order.
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
 * Replace the org default set for (space, integration).
 *
 * Delete-then-insert inside ONE transaction rather than a per-row upsert: the
 * write carries the whole set, so a member the caller dropped has to disappear
 * in the same statement that adds the new ones — a partial set is a different
 * governance decision from the one the admin made.
 */
export async function upsertOrgDefault(
  scope: SpaceScope,
  integrationId: string,
  input: UpsertOrgDefaultInput,
  /** Test-only seam — same shape and same purpose as `upsertIntegrationPin`'s. */
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
    // Serialize the whole set write per (space, integration) — see the same
    // lock in `integration-pins-service.ts`. Without it two concurrent PUTs
    // leave the union of their sets behind, past the cap and, worse, with the
    // two `enforce` values mixed across rows the resolver reads as one.
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
    // Test-only seam — see `opts.onBeforeCommit` on the signature above.
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
