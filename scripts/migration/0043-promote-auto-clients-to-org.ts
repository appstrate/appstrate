#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0043 — space-tier auto-provisioned (DCR/CIMD) OAuth clients moved to their org tier:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0043-promote-auto-clients-to-org.ts [--apply]
 *
 * An auto-provisioned client lives at the org tier, one per (integration, auth, issuer). Each such
 * key holding a space-tier client gets one winner: the org-tier client if it exists, else the
 * space-tier client with the most connections (then the oldest, then the smallest id), promoted by
 * the service a space admin's promotion runs (`moveClientToOrgTier`). Every other space-tier client of the key is merged into the winner:
 * its connections are re-pointed (`client_ref`) and flagged `needs_reconnection` (their refresh
 * token belongs to the merged registration), then it is deleted. The user-owned rows of the whole
 * key are widened to org scope (`widenConnectionsToOrgScope`); end users' rows stay in their space.
 *
 * Run after the deploy, app up, `pg_dump` first, after `0044` and `0041`. Refuses an empty
 * `DATABASE_URL` (the client would open `./data/pglite`). One transaction per organization; dry run
 * by default (each rolled back), `--apply` commits each. With `--apply`, the space-tier auto clients
 * left must be 0, else it exits 1. Idempotent: a second run finds nothing to promote.
 */

import { parseArgs } from "node:util";
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  integrationConnections as c,
  integrationOauthClients as ioc,
  spaces,
} from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";

class DryRunRollback extends Error {}

const SPACE_AUTO: SQL = and(eq(ioc.autoProvisioned, true), isNotNull(ioc.spaceId))!;

export interface OrgAutoClientReport {
  orgId: string;
  /** Space-tier clients moved to the org tier. */
  promoted: number;
  /** Space-tier clients deleted after their connections moved to the winner. */
  merged: number;
  /** Connections re-pointed to a winner and flagged `needs_reconnection`. */
  repointed: number;
  /** User-owned connections widened to org scope. */
  widened: number;
}

export async function runPromoteAutoClientsToOrg(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<OrgAutoClientReport[]> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const { moveClientToOrgTier, widenConnectionsToOrgScope } =
    await import("../../apps/api/src/services/integration-connections.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const issuerKey = sql<string>`coalesce(${ioc.issuer}, '')`;
  const groups = await db
    .select({
      orgId: ioc.orgId,
      integrationId: ioc.integrationId,
      authKey: ioc.authKey,
      issuer: issuerKey,
      n: sql<number>`count(*)::int`,
    })
    .from(ioc)
    .where(SPACE_AUTO)
    .groupBy(ioc.orgId, ioc.integrationId, ioc.authKey, issuerKey)
    .orderBy(ioc.orgId, ioc.integrationId, ioc.authKey, issuerKey);
  out(`to promote: ${groups.reduce((sum, group) => sum + group.n, 0)}`);

  const reports: OrgAutoClientReport[] = [];
  for (const orgId of [...new Set(groups.map((group) => group.orgId))]) {
    const report: OrgAutoClientReport = {
      orgId,
      promoted: 0,
      merged: 0,
      repointed: 0,
      widened: 0,
    };
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        for (const group of groups.filter((g) => g.orgId === orgId)) {
          const ofKey = and(
            eq(ioc.orgId, orgId),
            eq(ioc.integrationId, group.integrationId),
            eq(ioc.authKey, group.authKey),
            eq(ioc.autoProvisioned, true),
            sql`coalesce(${ioc.issuer}, '') = ${group.issuer}`,
          );
          // A space deletion's order: the spaces, then their clients, then the connections.
          const spaceIds = await tx
            .selectDistinct({ id: ioc.spaceId })
            .from(ioc)
            .where(and(ofKey, isNotNull(ioc.spaceId)));
          await tx
            .select({ id: spaces.id })
            .from(spaces)
            .where(
              inArray(
                spaces.id,
                spaceIds.map((row) => row.id!),
              ),
            )
            .orderBy(asc(spaces.id))
            .for("key share");
          const clients = await tx
            .select()
            .from(ioc)
            .where(ofKey)
            .orderBy(asc(ioc.id))
            .for("update");
          const spaceClients = clients.filter((client) => client.spaceId !== null);
          if (spaceClients.length === 0) continue;
          const ids = clients.map((client) => client.id);

          let winner = clients.find((client) => client.spaceId === null);
          if (!winner) {
            const counts = await tx
              .select({ clientRef: c.clientRef, n: sql<number>`count(*)::int` })
              .from(c)
              .where(inArray(c.clientRef, ids))
              .groupBy(c.clientRef);
            const countOf = (id: string) => counts.find((row) => row.clientRef === id)?.n ?? 0;
            winner = [...spaceClients].sort(
              (a, b) =>
                countOf(b.id) - countOf(a.id) ||
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            )[0]!;
            const promoted = await moveClientToOrgTier(
              tx,
              { orgId, spaceId: winner.spaceId! },
              group.integrationId,
              winner.id,
              true,
            );
            report.widened += promoted.widened.length;
            report.promoted++;
          }
          const winnerId = winner.id;
          const losers = spaceClients.filter((client) => client.id !== winnerId).map((l) => l.id);

          const widened = await widenConnectionsToOrgScope(tx, inArray(c.clientRef, ids));
          report.widened += widened.length;
          if (losers.length > 0) {
            const repointed = await tx
              .update(c)
              .set({ clientRef: winnerId, needsReconnection: true, updatedAt: new Date() })
              .where(inArray(c.clientRef, losers))
              .returning({ id: c.id });
            report.repointed += repointed.length;
            await tx.delete(ioc).where(inArray(ioc.id, losers));
            report.merged += losers.length;
          }
        }
        out(
          `org ${orgId}: promoted ${report.promoted}, merged ${report.merged}, re-pointed ${report.repointed}, widened ${report.widened}`,
        );
        if (!apply) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
    reports.push(report);
  }
  if (!apply) {
    out("0043: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return reports;
  }
  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(ioc)
    .where(SPACE_AUTO);
  out(`space-tier auto clients left: ${left!.n}`);
  if (left!.n !== 0) throw new Error("space-tier auto clients are left");
  out("0043: APPLIED — committed.");
  return reports;
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
    out(`0043 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runPromoteAutoClientsToOrg({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0043: FAILED — ${getErrorMessage(error)}. The failing organization is rolled back; with --apply, those before it stay committed and a re-run promotes what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
