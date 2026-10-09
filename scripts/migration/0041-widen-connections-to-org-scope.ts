#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0041 — existing connections widened to org scope (#1870):
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0041-widen-connections-to-org-scope.ts [--apply]
 *
 * From drizzle `0086` a connection's scope is the tier of the OAuth client that minted it, and
 * every row it found is space-scoped, which keeps the reach it had before the release. This widens
 * the user-owned rows minted by a system or org client, or by none, with
 * `widenConnectionsToOrgScope` — what promoting a space client to the org does: `space_id` NULL,
 * `origin_space_id` the old space, shares kept, a label the owner already holds at org scope
 * renamed `<label> (n)`. An end user's row and a space client's row (a legacy DCR one included)
 * stay in their space. Pins and defaults resolve the same connections: a widened row stays usable
 * in its origin space, and only its owner and the spaces it is shared with can bind it.
 *
 * Run after the deploy, app up, `pg_dump` first. Refuses an empty `DATABASE_URL` (the client
 * would open `./data/pglite`) and prints the database it reached first. One transaction per
 * organization, so the label locks a transaction holds stay bounded; dry run by default (each
 * rolled back), `--apply` commits each. An organization is refused (rolled back, exit 1, the run
 * stops there) unless its checks after the widening are all 0; once every one is committed, the
 * same checks over the whole table must be 0 too. Idempotent: a re-run widens only what is left.
 */

import { parseArgs } from "node:util";
import { notInArray, sql, type SQL } from "drizzle-orm";
import { integrationConnections as c, integrationOauthClients } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";

class DryRunRollback extends Error {}

/** User-owned, space-scoped, not minted by a space client. Table-qualified: never alias the table. */
const TO_WIDEN: SQL = sql`${c.spaceId} IS NOT NULL AND ${c.endUserId} IS NULL AND NOT EXISTS (
  SELECT 1 FROM ${integrationOauthClients} o WHERE o.id::text = ${c.clientRef} AND o.space_id IS NOT NULL)`;

/** The checks that must be 0 after the widening, over the rows `scope` selects. */
const checksOver = (scope: SQL): Record<string, SQL> => ({
  "left to widen": sql`SELECT 1 FROM ${c} WHERE ${scope} AND (${TO_WIDEN})`,
  // Org-scoped rows the scope rule forbids: an end user's, or a space client's.
  "org-scoped rows of an end user or a space client": sql`SELECT 1 FROM ${c} WHERE ${scope}
    AND ${c.spaceId} IS NULL AND (${c.endUserId} IS NOT NULL OR EXISTS (
      SELECT 1 FROM ${integrationOauthClients} o WHERE o.id::text = ${c.clientRef} AND o.space_id IS NOT NULL))`,
  // Groups of `idx_integration_conn_owner_label`'s key holding a label twice.
  "owner labels held twice": sql`SELECT 1 FROM ${c} WHERE ${scope}
    GROUP BY ${c.orgId}, coalesce(${c.spaceId}, ''), ${c.integrationId}, coalesce(${c.userId}, ${c.endUserId}), ${c.label}
    HAVING count(*) > 1`,
});

/** Labels the widening renames: per owner key at org scope, all but one of each group. */
const LABELS_TO_RENAME: SQL = sql`SELECT coalesce(sum(n - 1), 0)::int AS n FROM (
  SELECT count(*) AS n FROM ${c} WHERE (${TO_WIDEN}) OR ${c.spaceId} IS NULL
  GROUP BY ${c.orgId}, ${c.integrationId}, ${c.userId}, ${c.label} HAVING count(*) > 1) g`;

/** Rows to widen in a space with its own manual client for their auth: usable there by origin. */
const UNDER_SPACE_CLIENT: SQL = sql`SELECT 1 FROM ${c} WHERE ${TO_WIDEN} AND EXISTS (
  SELECT 1 FROM ${integrationOauthClients} o WHERE o.space_id = ${c.spaceId}
    AND o.integration_package_id = ${c.integrationId} AND o.auth_key = ${c.authKey}
    AND NOT o.auto_provisioned)`;

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
  // Imported here, not at the top: `@appstrate/db/client` opens its database on import, and the
  // entry point refuses the embedded one before that.
  const { db, toRows } = await import("@appstrate/db/client");
  const { widenConnectionsToOrgScope } =
    await import("../../apps/api/src/services/integration-connections.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);
  type Exec = Pick<typeof db, "execute">;
  const scalar = async (exec: Exec, query: SQL): Promise<number> =>
    toRows<{ n: number }>(await exec.execute(query))[0]!.n;
  const count = (exec: Exec, query: SQL) =>
    scalar(exec, sql`SELECT count(*)::int AS n FROM (${query}) q`);
  /** The checks' counts over `scope`; printed, and true when all are 0. */
  const checksPass = async (exec: Exec, scope: SQL, indent: string): Promise<boolean> => {
    let pass = true;
    for (const [name, query] of Object.entries(checksOver(scope))) {
      const n = await count(exec, query);
      out(`${indent}${name}: ${n}`);
      pass &&= n === 0;
    }
    return pass;
  };

  const perOrg = await db
    .select({ orgId: c.orgId, n: sql<number>`count(*)::int` })
    .from(c)
    .where(TO_WIDEN)
    .groupBy(c.orgId)
    .orderBy(c.orgId);
  out(`to widen: ${perOrg.reduce((sum, row) => sum + row.n, 0)}`);
  for (const row of perOrg) out(`  org ${row.orgId}: ${row.n}`);
  out(`labels to rename: ${await scalar(db, LABELS_TO_RENAME)}`);
  out(`in a space with its own OAuth client (info): ${await count(db, UNDER_SPACE_CLIENT)}`);

  const widened: WidenedConnection[] = [];
  for (const { orgId } of perOrg) {
    const inOrg = sql`${c.orgId} = ${orgId}`;
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        const rows = await widenConnectionsToOrgScope(tx, sql`${inOrg} AND (${TO_WIDEN})`);
        const relabeled = rows.filter((row) => row.label !== row.previousLabel);
        out(`org ${orgId}: widened ${rows.length}, relabeled ${relabeled.length}`);
        for (const row of relabeled) {
          out(
            `  relabel ${row.id}: ${JSON.stringify(row.previousLabel)} → ${JSON.stringify(row.label)}`,
          );
        }
        if (!(await checksPass(tx, inOrg, "  "))) {
          throw new Error(`a check after the widening is not 0 in org ${orgId}`);
        }
        widened.push(...rows);
        if (!apply) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
  }
  const relabeledCount = widened.filter((row) => row.label !== row.previousLabel).length;
  out(`connections widened: ${widened.length}, relabeled: ${relabeledCount}`);
  // The whole table once committed; on a dry run, the organizations no transaction checked.
  const rest =
    apply || perOrg.length === 0
      ? sql`true`
      : notInArray(
          c.orgId,
          perOrg.map((row) => row.orgId),
        );
  if (!(await checksPass(db, rest, ""))) {
    throw new Error("a check after the widening is not 0 over the whole table");
  }
  if (!apply) {
    out("0041: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return widened;
  }
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
    // An empty DATABASE_URL makes `@appstrate/db/client` open ./data/pglite instead.
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
