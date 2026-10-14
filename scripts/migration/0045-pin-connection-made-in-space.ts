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
 * member who connected one integration from two spaces owns two in every space.
 *
 * Rule and schedule listing: scripts/migration/README.md, Detail (script `0045`).
 *
 * Run after `0041 --apply` and `0043 --apply`, in the same window, the app stopped until this has
 * run (a schedule fire answering `must_choose_connection` before its pins exist disables the
 * schedule), `pg_dump` first; it refuses to run while `0041` or `0043` has work left.
 * Targets `DATABASE_URL`, or an embedded database named by `PGLITE_DATA_DIR` (the platform stopped:
 * PGlite opens in one process); with neither set it refuses, rather than open `./data/pglite`.
 * One transaction per organization; dry run by default (each rolled back), `--apply` commits
 * each. With `--apply`, the pins left to write must be 0, else it exits 1. Idempotent: a second run finds nothing to pin.
 */

import { parseArgs } from "node:util";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  auditEvents,
  integrationConnections as c,
  integrationOauthClients,
  integrationOrgDefaults,
  integrationPins,
  organizationMembers,
  packages,
  packageVersions,
  runs,
  schedules,
} from "@appstrate/db/schema";
import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { getErrorMessage } from "@appstrate/core/errors";
import type { DbOrTx } from "../../apps/api/src/lib/db-helpers.ts";
import { sharedInto, usableInSpace } from "../../apps/api/src/services/connection-reach.ts";
import { TO_WIDEN } from "./0041-widen-connections-to-org-scope.ts";
import { SPACE_AUTO } from "./0043-promote-auto-clients-to-org.ts";

class DryRunRollback extends Error {}

const THROUGH_PIN = "binds through the pin";
const NO_PIN = "no pin: name the set";

interface Pin {
  spaceId: string;
  userId: string;
  agentId: string;
  integrationId: string;
  connectionId: string;
}

/** An enabled schedule naming no set where its member owns several: what its fire binds through. */
interface UnnamedSchedule {
  scheduleId: string;
  spaceId: string;
  userId: string;
  agentId: string;
  integrationId: string;
  verdict: typeof THROUGH_PIN | typeof NO_PIN;
}

interface Plan {
  pins: Pin[];
  schedules: UnnamedSchedule[];
}

/**
 * The agents whose last run by the member there recording the integration bound `connectionId`
 * alone, by default, after `since`.
 */
async function agentsBoundByDefault(
  dbx: DbOrTx,
  at: { orgId: string; spaceId: string; userId: string; integrationId: string },
  connectionId: string,
  since: number,
): Promise<string[]> {
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
        eq(runs.orgId, at.orgId),
        eq(runs.spaceId, at.spaceId),
        eq(runs.userId, at.userId),
        eq(packages.ephemeral, false),
        sql`${runs.resolvedConnections} ? ${at.integrationId}`,
      ),
    )
    .orderBy(runs.packageId, desc(runs.startedAt), desc(runs.id));
  return lastRuns
    .filter((run) => {
      const bound = run.resolvedConnections?.[at.integrationId] ?? [];
      const only = bound.length === 1 ? bound[0] : undefined;
      if (only?.connectionId !== connectionId || only.source !== "fallback_auto") return false;
      return run.startedAt.getTime() > since;
    })
    .map((run) => run.agentId);
}

/**
 * The integrations each agent declares, by its draft and by every version not yanked: a fire runs a
 * published version, so a draft that dropped one still reaches it.
 */
async function declaredByAgent(
  dbx: DbOrTx,
  firing: { agentId: string; draftManifest: unknown }[],
): Promise<Map<string, Set<string>>> {
  const declared = new Map<string, Set<string>>();
  const declare = (agentId: string, manifest: unknown) => {
    const ids = declared.get(agentId) ?? new Set<string>();
    for (const entry of parseManifestIntegrations((manifest ?? {}) as Record<string, unknown>)) {
      ids.add(entry.id);
    }
    declared.set(agentId, ids);
  };
  for (const schedule of firing) declare(schedule.agentId, schedule.draftManifest);
  const agentIds = [...new Set(firing.map((schedule) => schedule.agentId))];
  if (agentIds.length > 0) {
    const versions = await dbx
      .select({ packageId: packageVersions.packageId, manifest: packageVersions.manifest })
      .from(packageVersions)
      .where(and(inArray(packageVersions.packageId, agentIds), eq(packageVersions.yanked, false)));
    for (const version of versions) declare(version.packageId, version.manifest);
  }
  return declared;
}

/** The member pins `orgId` is owed, and its enabled schedules naming no set among several. */
async function planOrg(dbx: DbOrTx, orgId: string): Promise<Plan> {
  const members = await dbx
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const isMember = new Set(members.map((row) => row.userId));
  const made = await dbx
    .selectDistinct({ spaceId: c.spaceId, originSpaceId: c.originSpaceId, userId: c.userId })
    .from(c)
    .where(and(eq(c.orgId, orgId), isNotNull(c.userId)));
  const scheduled = await dbx
    .selectDistinct({ spaceId: schedules.spaceId, userId: schedules.userId })
    .from(schedules)
    .where(and(eq(schedules.orgId, orgId), eq(schedules.enabled, true)));
  // Where a member made a connection (a pin may be owed) or runs a schedule (it may need a set).
  const pairs = new Map<string, { spaceId: string; userId: string }>();
  for (const row of [...made, ...scheduled.map((pair) => ({ ...pair, originSpaceId: null }))]) {
    const spaceId = row.spaceId ?? row.originSpaceId;
    if (!spaceId || !row.userId || !isMember.has(row.userId)) continue;
    pairs.set(`${spaceId} ${row.userId}`, { spaceId, userId: row.userId });
  }

  const plan: Plan = { pins: [], schedules: [] };
  for (const key of [...pairs.keys()].sort()) {
    const { spaceId, userId } = pairs.get(key)!;
    const mine = and(
      eq(c.orgId, orgId),
      eq(c.userId, userId),
      usableInSpace(spaceId, { type: "user", id: userId }),
    );
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
      .where(and(mine, sharedInto(spaceId)));
    const sharedIds = new Set(shared.map((row) => row.id));
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
    const declaredIds = await declaredByAgent(dbx, firing);

    for (const integrationId of [...new Set(own.map((row) => row.integrationId))].sort()) {
      const usable = own.filter((row) => row.integrationId === integrationId);
      if (usable.length < 2) continue;
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

      const madeHere = usable.filter((row) => (row.spaceId ?? row.originSpaceId) === spaceId);
      const others = usable.filter((row) => (row.spaceId ?? row.originSpaceId) !== spaceId);
      if (madeHere.length === 1 && !others.some((row) => sharedIds.has(row.id))) {
        const connectionId = madeHere[0]!.id;
        const since = Math.max(...others.map((row) => row.createdAt.getTime()));
        const at = { orgId, spaceId, userId, integrationId };
        for (const agentId of await agentsBoundByDefault(dbx, at, connectionId, since)) {
          if (byAdmin.has(agentId) || byMember.has(agentId)) continue;
          plan.pins.push({ spaceId, userId, agentId, integrationId, connectionId });
          byMember.add(agentId);
        }
      }

      for (const schedule of firing) {
        if (schedule.connectionOverrides?.[integrationId] !== undefined) continue;
        if (byAdmin.has(schedule.agentId)) continue;
        if (!declaredIds.get(schedule.agentId)?.has(integrationId)) continue;
        plan.schedules.push({
          scheduleId: schedule.id,
          spaceId,
          userId,
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
  const { pinAuditResourceId } =
    await import("../../apps/api/src/services/integration-pins-service.ts");
  const [target] = toRows<{ name: string; addr: string | null; port: number | null }>(
    await db.execute(
      "SELECT current_database() AS name, inet_server_addr()::text AS addr, inet_server_port() AS port",
    ),
  );
  out(`database: ${target!.name} at ${target!.addr ?? "local socket"}:${target!.port ?? "-"}`);
  const [widen] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(c)
    .where(TO_WIDEN);
  const [autoLeft] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(integrationOauthClients)
    .where(SPACE_AUTO);
  out(`left to widen (0041): ${widen!.n}`);
  out(`space-tier auto clients left (0043): ${autoLeft!.n}`);
  if (widen!.n !== 0 || autoLeft!.n !== 0) {
    throw new Error("0041 or 0043 has work left — run them with --apply first");
  }

  // The organizations owning a user connection: no other is owed a pin or lists a schedule.
  const orgs = await db
    .selectDistinct({ orgId: c.orgId })
    .from(c)
    .where(isNotNull(c.userId))
    .orderBy(c.orgId);

  const result: Plan = { pins: [], schedules: [] };
  for (const { orgId } of orgs) {
    const batch: Plan = { pins: [], schedules: [] };
    const lines: string[] = [];
    try {
      await db.transaction(async (tx) => {
        await tx.execute("SET LOCAL lock_timeout = '5s'");
        await tx.execute("SET LOCAL statement_timeout = '300s'");
        // As `validatePinTargets` asks, each connection is its member's, of the integration and
        // usable in the space; that the agent is active there is not checked.
        const { pins, schedules: unnamed } = await planOrg(tx, orgId);
        for (const pin of pins) {
          const inserted = await tx
            .insert(integrationPins)
            .values({
              spaceId: pin.spaceId,
              packageId: pin.agentId,
              integrationId: pin.integrationId,
              userId: pin.userId,
              connectionIds: [pin.connectionId],
            })
            .onConflictDoNothing()
            .returning({ id: integrationPins.id });
          // Pinned meanwhile by the member: nothing to write or to report for it.
          if (inserted.length === 0) continue;
          await tx.insert(auditEvents).values({
            orgId,
            spaceId: pin.spaceId,
            actorType: "system",
            action: "integration.member_pin.upserted",
            resourceType: "integration_pin",
            resourceId: pinAuditResourceId(pin.agentId, pin.integrationId),
            after: { connectionIds: [pin.connectionId], userId: pin.userId, reason: "migrated" },
          });
          batch.pins.push(pin);
          lines.push(
            `  pin ${pin.agentId} / ${pin.integrationId} → ${pin.connectionId} (space ${pin.spaceId}, member ${pin.userId})`,
          );
        }
        for (const row of unnamed) {
          lines.push(
            `  schedule ${row.scheduleId}: ${row.agentId} / ${row.integrationId} (space ${row.spaceId}, member ${row.userId}) — ${row.verdict}`,
          );
        }
        batch.schedules.push(...unnamed);
        if (!apply) throw new DryRunRollback();
      });
    } catch (error) {
      if (!(error instanceof DryRunRollback)) {
        throw new Error(`org ${orgId}: ${getErrorMessage(error)}`, { cause: error });
      }
    }
    if (lines.length === 0) continue;
    result.pins.push(...batch.pins);
    result.schedules.push(...batch.schedules);
    out(
      `org ${orgId}: pinned ${batch.pins.length}, schedules naming no set ${batch.schedules.length}`,
    );
    for (const line of lines) out(line);
  }
  const unpinned = result.schedules.filter((schedule) => schedule.verdict === NO_PIN);
  out(`pins: ${result.pins.length}`);
  out(`schedules with no pin: ${unpinned.length}`);
  if (!apply) {
    out("0045: DRY RUN — rolled back, nothing written. Re-run with --apply to commit.");
    return result;
  }
  let left = 0;
  for (const { orgId } of orgs) left += (await planOrg(db, orgId)).pins.length;
  out(`left to pin: ${left}`);
  if (left !== 0) throw new Error("pins are left to write after --apply");
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
    if (!process.env.DATABASE_URL && !process.env.PGLITE_DATA_DIR) {
      throw new Error(
        "neither DATABASE_URL nor PGLITE_DATA_DIR is set — refusing the default ./data/pglite; " +
          "load the .env, or name an embedded database with PGLITE_DATA_DIR",
      );
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
