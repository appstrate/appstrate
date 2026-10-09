#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0041 — existing connections widened to org scope:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0041-widen-connections-to-org-scope.ts [--apply]
 *
 * From drizzle `0086` a connection's scope is the tier of the OAuth client that minted it, and
 * every row it found is space-scoped. This widens the user-owned rows minted by a system or org
 * client, or by none, with `widenConnectionsToOrgScope` (what promoting a space client does).
 * End users' rows and space clients' rows (a space-tier auto client's included) stay in their space.
 *
 * Run after the deploy, app up, `pg_dump` first. Refuses an empty `DATABASE_URL` (the client
 * would open `./data/pglite`). One transaction per organization, so the label locks stay bounded;
 * dry run by default (each rolled back), `--apply` commits each. Idempotent.
 */

import { parseArgs } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { integrationConnections as c, integrationOauthClients } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";

class DryRunRollback extends Error {}

/** User-owned, space-scoped, not minted by a space client. Table-qualified: never alias the table. */
const TO_WIDEN: SQL = sql`${c.spaceId} IS NOT NULL AND ${c.endUserId} IS NULL AND NOT EXISTS (
  SELECT 1 FROM ${integrationOauthClients} o WHERE o.id::text = ${c.clientRef} AND o.space_id IS NOT NULL)`;

export interface WidenedConnection {
  id: string;
  label: string;
  previousLabel: string;
}

/** @returns the connections widened (or that would be, on a dry run). */
export async function runWidenConnectionsToOrgScope(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<WidenedConnection[]> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const { widenConnectionsToOrgScope } =
    await import("../../apps/api/src/services/integration-connections.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const perOrg = await db
    .select({ orgId: c.orgId, n: sql<number>`count(*)::int` })
    .from(c)
    .where(TO_WIDEN)
    .groupBy(c.orgId)
    .orderBy(c.orgId);
  out(`to widen: ${perOrg.reduce((sum, row) => sum + row.n, 0)}`);

  const widened: WidenedConnection[] = [];
  for (const { orgId } of perOrg) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        const rows = await widenConnectionsToOrgScope(
          tx,
          sql`${c.orgId} = ${orgId} AND (${TO_WIDEN})`,
        );
        const relabeled = rows.filter((row) => row.label !== row.previousLabel);
        out(`org ${orgId}: widened ${rows.length}, relabeled ${relabeled.length}`);
        for (const row of relabeled) {
          out(
            `  relabel ${row.id}: ${JSON.stringify(row.previousLabel)} → ${JSON.stringify(row.label)}`,
          );
        }
        widened.push(...rows);
        if (!apply) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
  }
  if (!apply) {
    out("0041: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return widened;
  }
  const [left] = toRows<{ n: number }>(
    await db.execute(sql`SELECT count(*)::int AS n FROM ${c} WHERE ${TO_WIDEN}`),
  );
  out(`left to widen: ${left!.n}`);
  if (left!.n !== 0) throw new Error("rows are left to widen");
  out("0041: APPLIED — committed.");
  return widened;
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
    out(`0041 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runWidenConnectionsToOrgScope({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0041: FAILED — ${getErrorMessage(error)}. The failing organization is rolled back; with --apply, those before it stay committed and a re-run widens what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
