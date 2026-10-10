#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0043 — space-tier auto-provisioned (DCR/CIMD) OAuth clients moved to their org tier:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0043-promote-auto-clients-to-org.ts [--apply]
 *
 * An auto-provisioned client lives at the org tier, one per (integration, auth, issuer). Each such
 * key holding a space-tier client gets one winner among all its clients, org tier included: the one
 * minting the most connections, a tie going to the org-tier client, then the oldest, then the
 * smallest id. Every other client of the key is merged into the winner: its connections are
 * re-pointed (`client_ref`) and flagged `needs_reconnection` (their refresh token belongs to the
 * merged registration, `repointConnectionsToClient`), then it is deleted. A space-tier winner is
 * then promoted by the service a space admin's promotion runs (`moveClientToOrgTier`), once the
 * org-tier client it beat is gone (one auto client per key and tier). The user-owned rows of the
 * whole key are widened to org scope (`widenConnectionsToOrgScope`), each recorded as a `system`
 * `integration.connection.scope_widened` audit row in the space it left; end users' rows stay in
 * their space.
 *
 * Run after the deploy, app up, `pg_dump` first, after `0044` and `0041`. Refuses an empty
 * `DATABASE_URL` (the client would open `./data/pglite`). One transaction per organization; dry run
 * by default (each rolled back), `--apply` commits each. With `--apply`, the space-tier auto clients
 * left must be 0, else it exits 1. Idempotent: a second run finds nothing to promote.
 */

import { parseArgs } from "node:util";
import { and, asc, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections as c,
  integrationOauthClients as ioc,
  spaces,
} from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import type { WidenedConnection } from "../../apps/api/src/services/integration-connections.ts";

class DryRunRollback extends Error {}

const SPACE_AUTO: SQL = and(eq(ioc.autoProvisioned, true), isNotNull(ioc.spaceId))!;

export interface OrgAutoClientReport {
  orgId: string;
  /** Space-tier clients moved to the org tier. */
  promoted: number;
  /** Clients (either tier) deleted after their connections moved to the winner. */
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
  const { moveClientToOrgTier, repointConnectionsToClient, widenConnectionsToOrgScope } =
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
        const widened: WidenedConnection[] = [];
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

          const counts = await tx
            .select({ clientRef: c.clientRef, n: sql<number>`count(*)::int` })
            .from(c)
            .where(inArray(c.clientRef, ids))
            .groupBy(c.clientRef);
          const countOf = (id: string) => counts.find((row) => row.clientRef === id)?.n ?? 0;
          const winner = [...clients].sort(
            (a, b) =>
              countOf(b.id) - countOf(a.id) ||
              Number(a.spaceId !== null) - Number(b.spaceId !== null) ||
              a.createdAt.getTime() - b.createdAt.getTime() ||
              a.id.localeCompare(b.id),
          )[0]!;
          const losers = clients.filter((client) => client.id !== winner.id).map((l) => l.id);
          if (losers.length > 0) {
            const repointed = await repointConnectionsToClient(tx, losers, winner.id);
            report.repointed += repointed.length;
            await tx.delete(ioc).where(inArray(ioc.id, losers));
            report.merged += losers.length;
          }
          if (winner.spaceId !== null) {
            const promoted = await moveClientToOrgTier(
              tx,
              { orgId, spaceId: winner.spaceId },
              group.integrationId,
              winner.id,
              true,
            );
            widened.push(...promoted.widened);
            report.promoted++;
          }

          widened.push(...(await widenConnectionsToOrgScope(tx, eq(c.clientRef, winner.id))));
        }
        report.widened = widened.length;
        for (const w of widened) {
          await tx.insert(auditEvents).values({
            orgId,
            spaceId: w.previousSpaceId,
            actorType: "system",
            action: "integration.connection.scope_widened",
            resourceType: "integration_connection",
            resourceId: w.id,
            before: { spaceId: w.previousSpaceId, label: w.previousLabel },
            after: { originSpaceId: w.previousSpaceId, label: w.label },
          });
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
