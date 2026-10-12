#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0045 — the connection a member made in a space pinned for the agents they run there by default:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0045-pin-space-connection.ts [--apply]
 *
 * With no pin, default or override, a run binds the actor's ONE own connection and answers
 * `must_choose_connection` on several. `0041` and `0043` widen user-owned rows to org scope, so a
 * member who connected one integration from two spaces owns two in each. For every (space, member,
 * integration) where the member owns several connections usable in the space (`usableInSpace`) and
 * exactly one made there (`coalesce(space_id, origin_space_id)`), and every agent one of their runs
 * in that space bound to that connection by `fallback_auto`, this writes the member pin naming it,
 * audited `integration.member_pin.upserted` by the `system` actor. It writes none where a layer
 * above the fallback names a set: a pin of theirs or an admin pin on the agent, a space default on
 * the integration. A deleted agent and an inline run's shadow take no pin.
 *
 * It lists, without writing, the enabled schedules of those members on those agents whose
 * `connection_overrides` names no set for the integration: their next fire binds through the pin.
 * End users have none to list: their rows stay in their space
 * (`integration_connections_end_user_is_space`), so every one usable in a space was made there.
 *
 * Run after `0041 --apply` and `0043 --apply`, app up, `pg_dump` first. Refuses an empty
 * `DATABASE_URL` (the client would open `./data/pglite`). One transaction per organization; dry run
 * by default (each rolled back), `--apply` commits each. With `--apply`, the pins left to write
 * must be 0, else it exits 1. Idempotent: a second run finds nothing to pin.
 */

import { parseArgs } from "node:util";
import { and, eq, isNotNull, isNull, notExists, or, sql, type SQL } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections as c,
  integrationOrgDefaults,
  integrationPins,
  packages,
  runs,
  schedules,
} from "@appstrate/db/schema";
import { getErrorMessage } from "@appstrate/core/errors";
import type { DbOrTx } from "../../apps/api/src/lib/db-helpers.ts";

class DryRunRollback extends Error {}

/** `usableInSpace` for a member: the platform's reach predicate, imported late with the client. */
type UsableBy = (spaceId: string, userId: string) => SQL;

interface Pin {
  spaceId: string;
  userId: string;
  agentId: string;
  integrationId: string;
  connectionId: string;
}

interface PinnedSchedule {
  scheduleId: string;
  agentId: string;
  integrationId: string;
}

/** The member pins `orgId` is owed, in (space, member, integration, agent) order. */
async function pinsOwed(dbx: DbOrTx, usableBy: UsableBy, orgId: string): Promise<Pin[]> {
  const made = await dbx
    .selectDistinct({ spaceId: c.spaceId, originSpaceId: c.originSpaceId, userId: c.userId })
    .from(c)
    .where(and(eq(c.orgId, orgId), isNotNull(c.userId)));
  const pairs = new Map<string, { spaceId: string; userId: string }>();
  for (const row of made) {
    const spaceId = row.spaceId ?? row.originSpaceId;
    if (spaceId) pairs.set(`${spaceId} ${row.userId}`, { spaceId, userId: row.userId! });
  }

  const pins: Pin[] = [];
  for (const key of [...pairs.keys()].sort()) {
    const { spaceId, userId } = pairs.get(key)!;
    const own = await dbx
      .select({
        id: c.id,
        integrationId: c.integrationId,
        spaceId: c.spaceId,
        originSpaceId: c.originSpaceId,
      })
      .from(c)
      .where(and(eq(c.orgId, orgId), eq(c.userId, userId), usableBy(spaceId, userId)));
    for (const integrationId of [...new Set(own.map((row) => row.integrationId))].sort()) {
      const usable = own.filter((row) => row.integrationId === integrationId);
      const madeHere = usable.filter((row) => (row.spaceId ?? row.originSpaceId) === spaceId);
      if (usable.length < 2 || madeHere.length !== 1) continue;
      const connectionId = madeHere[0]!.id;
      const boundByDefault = JSON.stringify({
        [integrationId]: [{ connectionId, source: "fallback_auto" }],
      });
      const agents = await dbx
        .selectDistinct({ id: packages.id })
        .from(runs)
        .innerJoin(packages, eq(packages.id, runs.packageId))
        .where(
          and(
            eq(runs.orgId, orgId),
            eq(runs.spaceId, spaceId),
            eq(runs.userId, userId),
            eq(packages.ephemeral, false),
            sql`${runs.resolvedConnections} @> ${boundByDefault}::jsonb`,
            notExists(
              dbx
                .select({ one: sql`1` })
                .from(integrationPins)
                .where(
                  and(
                    eq(integrationPins.spaceId, spaceId),
                    eq(integrationPins.packageId, packages.id),
                    eq(integrationPins.integrationId, integrationId),
                    or(isNull(integrationPins.userId), eq(integrationPins.userId, userId)),
                  ),
                ),
            ),
            notExists(
              dbx
                .select({ one: sql`1` })
                .from(integrationOrgDefaults)
                .where(
                  and(
                    eq(integrationOrgDefaults.spaceId, spaceId),
                    eq(integrationOrgDefaults.integrationId, integrationId),
                  ),
                ),
            ),
          ),
        )
        .orderBy(packages.id);
      for (const agent of agents) {
        pins.push({ spaceId, userId, agentId: agent.id, integrationId, connectionId });
      }
    }
  }
  return pins;
}

/** The enabled schedules whose fire binds through one of `pins`: no set of their own for it. */
async function schedulesOn(dbx: DbOrTx, orgId: string, pins: Pin[]): Promise<PinnedSchedule[]> {
  if (pins.length === 0) return [];
  const rows = await dbx
    .select({
      id: schedules.id,
      spaceId: schedules.spaceId,
      userId: schedules.userId,
      packageId: schedules.packageId,
      connectionOverrides: schedules.connectionOverrides,
    })
    .from(schedules)
    .where(and(eq(schedules.orgId, orgId), eq(schedules.enabled, true)))
    .orderBy(schedules.id);
  return rows.flatMap((schedule) =>
    pins
      .filter(
        (pin) =>
          pin.spaceId === schedule.spaceId &&
          pin.userId === schedule.userId &&
          pin.agentId === schedule.packageId &&
          schedule.connectionOverrides?.[pin.integrationId] === undefined,
      )
      .map((pin) => ({
        scheduleId: schedule.id,
        agentId: pin.agentId,
        integrationId: pin.integrationId,
      })),
  );
}

export async function runPinSpaceConnection(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<{ pins: Pin[]; schedules: PinnedSchedule[] }> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const { usableInSpace } = await import("../../apps/api/src/services/connection-reach.ts");
  const usableBy: UsableBy = (spaceId, userId) =>
    usableInSpace(spaceId, { type: "user", id: userId });
  const { pinAuditResourceId } =
    await import("../../apps/api/src/services/integration-pins-service.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const owed = async () => {
    const orgs = await db
      .selectDistinct({ orgId: c.orgId })
      .from(c)
      .where(isNotNull(c.userId))
      .orderBy(c.orgId);
    const perOrg: { orgId: string; n: number }[] = [];
    for (const { orgId } of orgs) {
      const n = (await pinsOwed(db, usableBy, orgId)).length;
      if (n > 0) perOrg.push({ orgId, n });
    }
    return perOrg;
  };
  const perOrg = await owed();
  out(`to pin: ${perOrg.reduce((sum, row) => sum + row.n, 0)}`);

  const result: { pins: Pin[]; schedules: PinnedSchedule[] } = { pins: [], schedules: [] };
  for (const { orgId } of perOrg) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        // Each connection comes out of `usableInSpace` for its member in this transaction: the
        // check a member pin write makes (`validatePinTargets`).
        const pins = await pinsOwed(tx, usableBy, orgId);
        const through = await schedulesOn(tx, orgId, pins);
        out(`org ${orgId}: pinned ${pins.length}, schedules on a pin ${through.length}`);
        for (const pin of pins) {
          await tx.insert(integrationPins).values({
            spaceId: pin.spaceId,
            packageId: pin.agentId,
            integrationId: pin.integrationId,
            userId: pin.userId,
            connectionIds: [pin.connectionId],
          });
          await tx.insert(auditEvents).values({
            orgId,
            spaceId: pin.spaceId,
            actorType: "system",
            action: "integration.member_pin.upserted",
            resourceType: "integration_pin",
            resourceId: pinAuditResourceId(pin.agentId, pin.integrationId),
            after: { connectionIds: [pin.connectionId], userId: pin.userId, reason: "migrated" },
          });
          out(
            `  pin ${pin.agentId} / ${pin.integrationId} → ${pin.connectionId} (space ${pin.spaceId}, member ${pin.userId})`,
          );
        }
        for (const schedule of through) {
          out(`  schedule ${schedule.scheduleId}: ${schedule.agentId} / ${schedule.integrationId}`);
        }
        result.pins.push(...pins);
        result.schedules.push(...through);
        if (!apply) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) throw error;
    }
  }
  if (!apply) {
    out("0045: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  const left = (await owed()).reduce((sum, row) => sum + row.n, 0);
  out(`left to pin: ${left}`);
  if (left !== 0) throw new Error("pins are left to write");
  out("0045: APPLIED — committed.");
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
    out(`0045 — ${apply ? "APPLY" : "DRY RUN"}`);
    await runPinSpaceConnection({ apply, out });
    code = 0;
  } catch (error) {
    process.stdout.write(
      `0045: FAILED — ${getErrorMessage(error)}. The failing organization is rolled back; with --apply, those before it stay committed and a re-run pins what is left.\n`,
    );
  } finally {
    await closeDb?.();
  }
  process.exit(code);
}
