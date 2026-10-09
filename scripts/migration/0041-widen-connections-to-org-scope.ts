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
 * would open `./data/pglite`) and prints the database it reached first. One transaction; dry run
 * by default (rolled back), `--apply` commits. Refused (rolled back, exit 1) unless the checks it
 * prints after the widening are all 0. Idempotent: a second run widens nothing.
 */

import { parseArgs } from "node:util";
import { sql, type SQL } from "drizzle-orm";
import { integrationConnections as c, integrationOauthClients } from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";

class DryRunRollback extends Error {}

/** User-owned, space-scoped, not minted by a space client. Table-qualified: never alias the table. */
const TO_WIDEN: SQL = sql`${c.spaceId} IS NOT NULL AND ${c.endUserId} IS NULL AND NOT EXISTS (
  SELECT 1 FROM ${integrationOauthClients} o WHERE o.id::text = ${c.clientRef} AND o.space_id IS NOT NULL)`;

/** Org-scoped rows the scope rule forbids: an end user's, or a space client's. */
const ORG_ROW_VIOLATIONS: SQL = sql`SELECT 1 FROM ${c} WHERE ${c.spaceId} IS NULL AND (${c.endUserId} IS NOT NULL OR EXISTS (
  SELECT 1 FROM ${integrationOauthClients} o WHERE o.id::text = ${c.clientRef} AND o.space_id IS NOT NULL))`;

/** Groups of `idx_integration_conn_owner_label`'s key holding a label twice. */
const DUPLICATE_OWNER_LABELS: SQL = sql`SELECT 1 FROM ${c}
  GROUP BY ${c.orgId}, coalesce(${c.spaceId}, ''), ${c.integrationId}, coalesce(${c.userId}, ${c.endUserId}), ${c.label}
  HAVING count(*) > 1`;

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
  let widened: WidenedConnection[] = [];
  try {
    await db.transaction(async (tx) => {
      await tx.execute("SET LOCAL lock_timeout = '5s'");
      await tx.execute("SET LOCAL statement_timeout = '300s'");
      const scalar = async (query: SQL): Promise<number> =>
        toRows<{ n: number }>(await tx.execute(query))[0]!.n;
      const count = (query: SQL) => scalar(sql`SELECT count(*)::int AS n FROM (${query}) q`);

      const perOrg = await tx
        .select({ orgId: c.orgId, n: sql<number>`count(*)::int` })
        .from(c)
        .where(TO_WIDEN)
        .groupBy(c.orgId)
        .orderBy(c.orgId);
      out(`to widen: ${perOrg.reduce((sum, row) => sum + row.n, 0)}`);
      for (const row of perOrg) out(`  org ${row.orgId}: ${row.n}`);
      out(`labels to rename: ${await scalar(LABELS_TO_RENAME)}`);
      out(`in a space with its own OAuth client (info): ${await count(UNDER_SPACE_CLIENT)}`);

      widened = await widenConnectionsToOrgScope(tx, TO_WIDEN);
      const relabeled = widened.filter((row) => row.label !== row.previousLabel);
      for (const row of relabeled) {
        out(
          `  relabel ${row.id}: ${JSON.stringify(row.previousLabel)} → ${JSON.stringify(row.label)}`,
        );
      }
      out(`connections widened: ${widened.length}, relabeled: ${relabeled.length}`);

      const checks = {
        "left to widen": await count(sql`SELECT 1 FROM ${c} WHERE ${TO_WIDEN}`),
        "org-scoped rows of an end user or a space client": await count(ORG_ROW_VIOLATIONS),
        "owner labels held twice": await count(DUPLICATE_OWNER_LABELS),
      };
      for (const [name, n] of Object.entries(checks)) out(`${name}: ${n}`);
      if (Object.values(checks).some((n) => n !== 0)) {
        throw new Error("a check after the widening is not 0");
      }
      if (!apply) throw new DryRunRollback();
    });
    out("0041: APPLIED — committed.");
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
    out("0041: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
  }
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
    process.stdout.write(`0041: FAILED, nothing committed — ${getErrorMessage(error)}\n`);
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
