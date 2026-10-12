#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

/**
 * 0045 — the connection a member made in a space pinned for the agents binding it there by default:
 *
 *   set -a && . ./.env && set +a && \
 *     bun scripts/migration/0045-pin-connection-made-in-space.ts [--apply]
 *
 * With no pin, default or override, a run binds the actor's ONE own connection and answers
 * `must_choose_connection` on several. `0041` and `0043` widen user-owned rows to org scope, so a
 * member who connected one integration from two spaces owns two in each. A (space, member,
 * integration) qualifies when the member owns several connections usable in the space
 * (`usableInSpace`), exactly one made there (`coalesce(space_id, origin_space_id)`), none of the
 * others shared into it (`sharedInto`: that one reached the space whatever its scope), and no org
 * default names a set for the integration there.
 *
 * Pins. For a qualifying tuple and an agent, the member pin naming the connection made there is
 * written when the member's most recent run of that agent in that space recording the integration
 * (`runs.resolved_connections`, a schedule's fire included) bound exactly that connection by
 * `fallback_auto` and started (`runs.started_at`, set when the run row is inserted, never NULL)
 * after each of the others was created: both existed and the space bound its own, which only the
 * scope explains. A later binding of another source, or a connection made since, is the member's
 * own word: no pin. Nor where they or an admin pinned the agent, on a deleted agent or an inline
 * run's shadow. Each pin is audited `integration.member_pin.upserted` by the `system` actor.
 *
 * Schedules, listed and never written. For a qualifying tuple, each enabled schedule running as
 * the member there whose agent declares the integration (draft manifest only) and whose
 * `connection_overrides` names no set for it, no admin pin governing the agent: `binds through the
 * pin` (theirs, existing or written here) or `no pin: name the set` (its fire answers
 * `must_choose_connection`). End users have none: their rows stay in their space
 * (`integration_connections_end_user_is_space`), so every one usable in a space was made there.
 *
 * Rows: UNMEASURED — the state it repairs exists only after `0041 --apply`, which no reachable
 * database has run. Rehearse on a restored dump, after `0041` and `0043` there.
 *
 * Run after `0041 --apply` and `0043 --apply`, app up, `pg_dump` first. Refuses an empty
 * `DATABASE_URL` (the client would open `./data/pglite`). One transaction per organization; dry run
 * by default (each rolled back), `--apply` commits each. With `--apply`, the pins left to write
 * must be 0, else it exits 1. Idempotent: a second run finds nothing to pin.
 */

import { parseArgs } from "node:util";
import { and, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections as c,
  integrationOrgDefaults,
  integrationPins,
  packages,
  runs,
  schedules,
} from "@appstrate/db/schema";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { getErrorMessage } from "@appstrate/core/errors";
import type { DbOrTx } from "../../apps/api/src/lib/db-helpers.ts";

class DryRunRollback extends Error {}

const THROUGH_PIN = "binds through the pin";
const NO_PIN = "no pin: name the set";

/** The platform's reach predicates (`connection-reach.ts`), imported late with the client. */
interface Reach {
  /** `usableInSpace` for a member. */
  usableBy: (spaceId: string, userId: string) => SQL;
  sharedInto: (spaceId: string) => SQL;
}

interface Pin {
  spaceId: string;
  userId: string;
  agentId: string;
  integrationId: string;
  connectionId: string;
}

/** An enabled schedule of a qualifying tuple naming no set: what its next fire binds through. */
interface UnnamedSchedule {
  scheduleId: string;
  agentId: string;
  integrationId: string;
  verdict: typeof THROUGH_PIN | typeof NO_PIN;
}

interface Plan {
  pins: Pin[];
  schedules: UnnamedSchedule[];
}

/** The member pins `orgId` is owed, and its schedules naming no set for a qualifying tuple. */
async function planOrg(dbx: DbOrTx, reach: Reach, orgId: string): Promise<Plan> {
  const made = await dbx
    .selectDistinct({ spaceId: c.spaceId, originSpaceId: c.originSpaceId, userId: c.userId })
    .from(c)
    .where(and(eq(c.orgId, orgId), isNotNull(c.userId)));
  const pairs = new Map<string, { spaceId: string; userId: string }>();
  for (const row of made) {
    const spaceId = row.spaceId ?? row.originSpaceId;
    if (spaceId) pairs.set(`${spaceId} ${row.userId}`, { spaceId, userId: row.userId! });
  }

  const plan: Plan = { pins: [], schedules: [] };
  for (const key of [...pairs.keys()].sort()) {
    const { spaceId, userId } = pairs.get(key)!;
    const mine = and(eq(c.orgId, orgId), eq(c.userId, userId), reach.usableBy(spaceId, userId));
    const own = await dbx
      .select({
        id: c.id,
        integrationId: c.integrationId,
        spaceId: c.spaceId,
        originSpaceId: c.originSpaceId,
        createdAt: c.createdAt,
      })
      .from(c)
      .where(mine);
    if (own.length < 2) continue;
    const shared = await dbx
      .select({ id: c.id })
      .from(c)
      .where(and(mine, reach.sharedInto(spaceId)));
    const sharedIds = new Set(shared.map((row) => row.id));

    for (const integrationId of [...new Set(own.map((row) => row.integrationId))].sort()) {
      const usable = own.filter((row) => row.integrationId === integrationId);
      const madeHere = usable.filter((row) => (row.spaceId ?? row.originSpaceId) === spaceId);
      const others = usable.filter((row) => (row.spaceId ?? row.originSpaceId) !== spaceId);
      if (madeHere.length !== 1 || others.length === 0) continue;
      if (others.some((row) => sharedIds.has(row.id))) continue;
      const orgDefault = await dbx
        .select({ id: integrationOrgDefaults.id })
        .from(integrationOrgDefaults)
        .where(
          and(
            eq(integrationOrgDefaults.spaceId, spaceId),
            eq(integrationOrgDefaults.integrationId, integrationId),
          ),
        );
      if (orgDefault.length > 0) continue;

      const connectionId = madeHere[0]!.id;
      const othersCreated = Math.max(...others.map((row) => row.createdAt.getTime()));
      const pinned = await dbx
        .select({ agentId: integrationPins.packageId, userId: integrationPins.userId })
        .from(integrationPins)
        .where(
          and(
            eq(integrationPins.spaceId, spaceId),
            eq(integrationPins.integrationId, integrationId),
            or(isNull(integrationPins.userId), eq(integrationPins.userId, userId)),
          ),
        );
      const byAdmin = new Set<string>();
      const byMember = new Set<string>();
      for (const pin of pinned) (pin.userId === null ? byAdmin : byMember).add(pin.agentId);

      // The member's last run of each agent there that recorded the integration.
      const lastRuns = await dbx
        .selectDistinctOn([runs.packageId], {
          agentId: packages.id,
          resolvedConnections: runs.resolvedConnections,
          startedAt: runs.startedAt,
        })
        .from(runs)
        .innerJoin(packages, eq(packages.id, runs.packageId))
        .where(
          and(
            eq(runs.orgId, orgId),
            eq(runs.spaceId, spaceId),
            eq(runs.userId, userId),
            eq(packages.ephemeral, false),
            sql`${runs.resolvedConnections} ? ${integrationId}`,
          ),
        )
        .orderBy(runs.packageId, desc(runs.startedAt), desc(runs.id));
      for (const run of lastRuns) {
        if (byAdmin.has(run.agentId) || byMember.has(run.agentId)) continue;
        const bound = run.resolvedConnections?.[integrationId] ?? [];
        const only = bound.length === 1 ? bound[0] : undefined;
        if (only?.connectionId !== connectionId || only.source !== "fallback_auto") continue;
        if (run.startedAt.getTime() <= othersCreated) continue;
        plan.pins.push({ spaceId, userId, agentId: run.agentId, integrationId, connectionId });
        byMember.add(run.agentId);
      }

      const firing = await dbx
        .select({
          id: schedules.id,
          agentId: schedules.packageId,
          connectionOverrides: schedules.connectionOverrides,
          draftManifest: packages.draftManifest,
        })
        .from(schedules)
        .innerJoin(packages, eq(packages.id, schedules.packageId))
        .where(
          and(
            eq(schedules.orgId, orgId),
            eq(schedules.spaceId, spaceId),
            eq(schedules.userId, userId),
            eq(schedules.enabled, true),
          ),
        )
        .orderBy(schedules.id);
      for (const schedule of firing) {
        if (schedule.connectionOverrides?.[integrationId] !== undefined) continue;
        if (byAdmin.has(schedule.agentId)) continue;
        const manifest = (schedule.draftManifest ?? {}) as Record<string, unknown>;
        const declared = parseManifestIntegrations(manifest).map((entry) => entry.id);
        if (!declared.includes(integrationId)) continue;
        plan.schedules.push({
          scheduleId: schedule.id,
          agentId: schedule.agentId,
          integrationId,
          verdict: byMember.has(schedule.agentId) ? THROUGH_PIN : NO_PIN,
        });
      }
    }
  }
  return plan;
}

export async function runPinConnectionMadeInSpace(options: {
  apply: boolean;
  out: (line: string) => void;
}): Promise<Plan> {
  const { apply, out } = options;
  // Imported here: `@appstrate/db/client` opens its database on import, after the entry point's guard.
  const { db, toRows } = await import("@appstrate/db/client");
  const { usableInSpace, sharedInto } =
    await import("../../apps/api/src/services/connection-reach.ts");
  const reach: Reach = {
    usableBy: (spaceId, userId) => usableInSpace(spaceId, { type: "user", id: userId }),
    sharedInto,
  };
  const { pinAuditResourceId } =
    await import("../../apps/api/src/services/integration-pins-service.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);

  const planned = async () => {
    const orgs = await db
      .selectDistinct({ orgId: c.orgId })
      .from(c)
      .where(isNotNull(c.userId))
      .orderBy(c.orgId);
    const perOrg: { orgId: string; pins: number; unpinned: number }[] = [];
    for (const { orgId } of orgs) {
      const plan = await planOrg(db, reach, orgId);
      if (plan.pins.length + plan.schedules.length === 0) continue;
      const unpinned = plan.schedules.filter((schedule) => schedule.verdict === NO_PIN).length;
      perOrg.push({ orgId, pins: plan.pins.length, unpinned });
    }
    return perOrg;
  };
  const perOrg = await planned();
  out(`to pin: ${perOrg.reduce((sum, row) => sum + row.pins, 0)}`);
  out(`schedules with no pin: ${perOrg.reduce((sum, row) => sum + row.unpinned, 0)}`);

  const result: Plan = { pins: [], schedules: [] };
  for (const { orgId } of perOrg) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        // Each connection comes out of `usableInSpace` for its member in this transaction: the
        // check a member pin write makes (`validatePinTargets`).
        const { pins, schedules: unnamed } = await planOrg(tx, reach, orgId);
        out(`org ${orgId}: pinned ${pins.length}, schedules naming no set ${unnamed.length}`);
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
        for (const schedule of unnamed) {
          out(
            `  schedule ${schedule.scheduleId}: ${schedule.agentId} / ${schedule.integrationId} — ${schedule.verdict}`,
          );
        }
        result.pins.push(...pins);
        result.schedules.push(...unnamed);
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
  const left = (await planned()).reduce((sum, row) => sum + row.pins, 0);
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
    await runPinConnectionMadeInSpace({ apply, out });
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
