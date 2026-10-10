#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0044 — connection shares copied into `integration_connection_shares`:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0044-connection-shares.ts [--apply]
 *
 * Drizzle `0089` creates `integration_connection_shares` and leaves `shared_space_ids` in place,
 * read by nothing but this script. Each `(id, unnest(shared_space_ids))` becomes one share row in
 * the connection's org (`shared_by` NULL), `ON CONFLICT DO NOTHING`; a target space that no longer
 * exists or belongs to another organization is skipped and printed. The column is then emptied on
 * every row that held one, and each connection that gained a share has its `updated_at` bumped (its
 * owner's open pages refetch). Then, in each organization that gained a share, the access-loss sweep
 * (`unshareConnectionsOfOwnersWithoutAccess`) withdraws the shares whose owner no longer reaches
 * their space and disables other actors' schedules naming them, as a live access loss does. Each
 * share added is audited `integration.connection.share_added`, each withdrawal `share_removed`
 * (`reason: access_lost`), both by the `system` actor. The target spaces are locked `FOR KEY SHARE`
 * in id order before any connection row, the order a space delete takes. Run FIRST after the
 * deploy, app up, `pg_dump` first: until it runs, no existing share is visible. Refuses an empty
 * `DATABASE_URL` (the client would open `./data/pglite`). One transaction; dry run by default
 * (rolled back), `--apply` commits. A second `--apply` finds the column empty and inserts nothing,
 * so a share withdrawn since the first stays withdrawn.
 */

import { parseArgs } from "node:util";
import { inArray, sql } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections as c,
  integrationConnectionShares,
  spaces,
} from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";

class DryRunRollback extends Error {}

export interface SkippedShare {
  connectionId: string;
  spaceId: string;
  /** `missing`: no such space; `foreign`: a space of another organization. */
  reason: "missing" | "foreign";
}

export interface ConnectionSharesCopy {
  inserted: number;
  /** Rows whose `shared_space_ids` was emptied once copied. */
  cleared: number;
  skipped: SkippedShare[];
  /** Shares whose owner no longer reaches the target space, removed after the copy. */
  withdrawn: Array<{ connectionId: string; spaceId: string }>;
  /** Other actors' schedules that named a withdrawn share, disabled as the service does. */
  disabledScheduleIds: string[];
}

/** Every `(connection, space)` pair the column holds, with the target's organization if it exists. */
const PAIRS = sql`${c} CROSS JOIN LATERAL unnest(${c.sharedSpaceIds}) AS pair(space_id)
  LEFT JOIN ${spaces} ON ${spaces.id} = pair.space_id`;

export async function runConnectionShares(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<ConnectionSharesCopy> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const { unshareConnectionsOfOwnersWithoutAccess } =
    await import("../../apps/api/src/services/space-members.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const result: ConnectionSharesCopy = {
    inserted: 0,
    cleared: 0,
    skipped: [],
    withdrawn: [],
    disabledScheduleIds: [],
  };
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      // Spaces before connections, the order a space delete takes.
      await tx.execute(sql`SELECT ${spaces.id} FROM ${spaces}
        WHERE ${spaces.id} IN (SELECT unnest(${c.sharedSpaceIds}) FROM ${c})
        ORDER BY ${spaces.id} FOR KEY SHARE`);
      const [counts] = toRows<{ pairs: number; to_copy: number }>(
        await tx.execute(sql`SELECT count(*)::int AS pairs,
            count(*) FILTER (WHERE ${spaces.orgId} = ${c.orgId} AND NOT EXISTS (
              SELECT 1 FROM ${integrationConnectionShares} s
              WHERE s.connection_id = ${c.id} AND s.space_id = pair.space_id))::int AS to_copy
          FROM ${PAIRS}`),
      );
      out(`shares in shared_space_ids: ${counts!.pairs}, to copy: ${counts!.to_copy}`);

      const skipped = toRows<{ connection_id: string; space_id: string; reason: string }>(
        await tx.execute(sql`SELECT ${c.id} AS connection_id, pair.space_id,
            CASE WHEN ${spaces.id} IS NULL THEN 'missing' ELSE 'foreign' END AS reason
          FROM ${PAIRS}
          WHERE ${spaces.id} IS NULL OR ${spaces.orgId} <> ${c.orgId}
          ORDER BY ${c.id}, pair.space_id`),
      );
      for (const row of skipped) {
        out(`  skipped ${row.connection_id} → ${row.space_id}: ${row.reason} space`);
        result.skipped.push({
          connectionId: row.connection_id,
          spaceId: row.space_id,
          reason: row.reason as SkippedShare["reason"],
        });
      }

      const inserted = toRows<{ connection_id: string; space_id: string; org_id: string }>(
        await tx.execute(sql`INSERT INTO ${integrationConnectionShares} (connection_id, space_id, org_id, shared_by)
          SELECT ${c.id}, pair.space_id, ${c.orgId}, NULL FROM ${PAIRS}
          WHERE ${spaces.orgId} = ${c.orgId}
          ORDER BY ${c.id}, pair.space_id
          ON CONFLICT DO NOTHING
          RETURNING connection_id, space_id, org_id`),
      );
      result.inserted = inserted.length;
      out(`inserted: ${result.inserted}, skipped: ${result.skipped.length}`);
      for (const share of inserted) {
        await tx.insert(auditEvents).values({
          orgId: share.org_id,
          spaceId: share.space_id,
          actorType: "system",
          action: "integration.connection.share_added",
          resourceType: "integration_connection",
          resourceId: share.connection_id,
          after: { spaceId: share.space_id },
        });
      }

      const cleared = await tx
        .update(c)
        .set({ sharedSpaceIds: [] })
        .where(sql`cardinality(${c.sharedSpaceIds}) > 0`)
        .returning({ id: c.id });
      result.cleared = cleared.length;
      const gained = [...new Set(inserted.map((row) => row.connection_id))];
      if (gained.length > 0) {
        await tx.update(c).set({ updatedAt: new Date() }).where(inArray(c.id, gained));
      }
      out(`shared_space_ids emptied: ${result.cleared}`);

      // An owner who lost a target space after the deploy: withdrawn as a live access loss does.
      const orgs = await tx
        .selectDistinct({ orgId: c.orgId })
        .from(c)
        .where(inArray(c.id, gained))
        .orderBy(c.orgId);
      for (const { orgId } of orgs) {
        const { shares, disabledScheduleIds } = await unshareConnectionsOfOwnersWithoutAccess(tx, {
          orgId,
        });
        for (const share of shares) {
          out(`  withdrawn ${share.connectionId} → ${share.spaceId}: owner without access`);
          await tx.insert(auditEvents).values({
            orgId,
            spaceId: share.spaceId,
            actorType: "system",
            action: "integration.connection.share_removed",
            resourceType: "integration_connection",
            resourceId: share.connectionId,
            after: { spaceId: share.spaceId, reason: "access_lost" },
          });
        }
        result.withdrawn.push(...shares);
        result.disabledScheduleIds.push(...disabledScheduleIds);
      }
      out(
        `withdrawn (owner without access): ${result.withdrawn.length}, schedules disabled: ${result.disabledScheduleIds.length}`,
      );
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0044: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  out("0044: APPLIED — committed.");
  return result;
}

if (import.meta.main) {
  let code = 1;
  let closeDb: (() => Promise<void>) | undefined;
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { apply: { type: "boolean" } },
      strict: true,
    });
    const apply = values.apply === true;
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is empty — refusing the embedded ./data/pglite; load the .env");
    }
    ({ closeDb } = await import("@appstrate/db/client"));
    const out = (line: string) => process.stdout.write(`${line}\n`);
    out(`0044 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runConnectionShares({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(`0044: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
