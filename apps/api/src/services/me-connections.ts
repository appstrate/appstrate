// SPDX-License-Identifier: Apache-2.0

/**
 * Unified user-scope connection aggregator backing `GET /api/me/connections`.
 *
 * Returns integration connections in a single shape, grouped by their
 * "source" (the package they connect to).
 *
 * Scope depends on the caller's AUTHORITY, not just their identity:
 *   - A `user` principal crosses orgs and spaces — the connection list
 *     belongs to the person, not to any single org context.
 *   - Every other kind authenticates as its issuer but is bound; its listing
 *     is hard-scoped to that binding at the SQL level so a leaked credential
 *     can never enumerate the issuer's connections elsewhere
 *     ({@link MeConnectionAuthority}).
 */

import { db } from "@appstrate/db/client";
import { and, eq, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import {
  spacePackages,
  packageShares,
  integrationConnections,
  organizationMembers,
  organizations,
  packages,
  schedules,
  spaces,
} from "@appstrate/db/schema";
import { actorFilter, type Actor } from "../lib/actor.ts";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";
import { asRecord } from "@appstrate/core/safe-json";
import { toISORequired } from "../lib/date-helpers.ts";
import {
  getPackageDisplayName,
  notEphemeralFilter,
  orgOrSystemFilter,
} from "../lib/package-helpers.ts";
import { activeHereSql } from "./package-activation.ts";
import { placementRowJoin, placementShareJoin } from "./package-placement.ts";
import { connectionLocks, planConnectionForget } from "./integration-connections.ts";

/**
 * The authority boundary of the credential presented on `/api/me/connections`.
 *
 * REQUIRED on every read/delete path of this module so the scoping decision
 * is made explicitly at the callsite and lands in the SQL `WHERE` — a caller
 * cannot "forget" to scope an API key.
 *
 *   - `user_global`: a `user` principal (cookie session, CLI or instance
 *     token, chat loopback). Cross-org, cross-space by design — that is the
 *     dashboard connections-management feature.
 *   - `bound`: any other kind — an API key (org + space), a third-party OAuth
 *     client (org only), an end-user token (org + space). Its blast radius is
 *     its binding, and that binding lands in the WHERE clause. On `main` an
 *     end-user token took the global view.
 */
export type MeConnectionAuthority =
  { kind: "user_global" } | { kind: "bound"; orgId: string; spaceId?: string };

/**
 * A `bound` authority's org (and space, when it pins one) as a WHERE conjunct — in the SQL, so a
 * bound credential can only ever SELECT rows inside its binding. Nothing for `user_global`.
 */
function authorityFilter(
  authority: MeConnectionAuthority,
  orgId: AnyColumn,
  spaceId: AnyColumn,
): SQL | undefined {
  if (authority.kind !== "bound") return undefined;
  return and(
    eq(orgId, authority.orgId),
    authority.spaceId ? eq(spaceId, authority.spaceId) : undefined,
  );
}

/**
 * The integration ids ONE agent's draft manifest declares, projected as a
 * `text[]` — so the reuse count below never pulls a whole `draft_manifest`
 * across the wire, and needs no LATERAL join outside the query builder.
 */
const declaredIntegrationIds = sql<string[]>`ARRAY(
  SELECT jsonb_object_keys(
    COALESCE(${packages.draftManifest} -> 'dependencies' -> 'integrations', '{}'::jsonb)
  )
)`;

/**
 * Fetch every integration_connections row owned by the actor, joined with
 * its space + integration package. Cross-space, cross-org for a
 * `user_global` authority; confined to the authority's org — and to its space
 * when it pins one — for a `bound` caller.
 */
async function listAllActorIntegrationConnections(
  actor: Actor,
  authority: MeConnectionAuthority,
): Promise<MeConnectionSourceGroup[]> {
  const rows = await db
    .select({
      connectionId: integrationConnections.id,
      packageId: integrationConnections.integrationId,
      authKey: integrationConnections.authKey,
      accountId: integrationConnections.accountId,
      spaceId: integrationConnections.spaceId,
      spaceName: spaces.name,
      orgId: spaces.orgId,
      scopesGranted: integrationConnections.scopesGranted,
      needsReconnection: integrationConnections.needsReconnection,
      expiresAt: integrationConnections.expiresAt,
      label: integrationConnections.label,
      sharedWithOrg: integrationConnections.sharedWithOrg,
      identityClaims: integrationConnections.identityClaims,
      createdAt: integrationConnections.createdAt,
    })
    .from(integrationConnections)
    .innerJoin(spaces, eq(integrationConnections.spaceId, spaces.id))
    .where(
      and(
        actorFilter(actor, integrationConnections),
        authorityFilter(authority, spaces.orgId, integrationConnections.spaceId),
      ),
    );

  if (rows.length === 0) return [];

  // Resolve org display names
  const uniqueOrgIds = [...new Set(rows.map((r) => r.orgId))];
  const orgRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(inArray(organizations.id, uniqueOrgIds));
  const orgNameMap = new Map(orgRows.map((o) => [o.id, o.name]));

  // For dashboard users, additionally filter to orgs they're still a member of.
  // (An integration connection survives the user leaving the org via on-delete cascade,
  // but if no cascade fired we still don't want stale rows.)
  if (actor.type === "user") {
    const memberOrgs = await db
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, actor.id));
    const memberSet = new Set(memberOrgs.map((m) => m.orgId));
    for (const id of uniqueOrgIds) {
      if (!memberSet.has(id)) orgNameMap.delete(id);
    }
  }

  // Resolve integration display names + icons
  const uniquePackageIds = [...new Set(rows.map((r) => r.packageId))];
  const pkgRows = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, uniquePackageIds));

  const packageInfo = new Map<string, { displayName: string; logo: string }>();
  for (const pkg of pkgRows) {
    const manifest = asRecord(pkg.draftManifest);
    packageInfo.set(pkg.id, {
      displayName: getPackageDisplayName(pkg),
      logo: typeof manifest.icon === "string" ? manifest.icon : "",
    });
  }

  // Count the agents each space RUNS that declare this integration in their
  // dependencies — "reused by N agents" is a statement about runs, so the
  // question is the ONE activation rule ({@link activeHereSql}) and not the
  // presence of a `space_packages` row: a deactivated agent, and an ORPHAN row
  // naming a package the space has lost, execute nowhere and reuse nothing.
  //
  // That rule is per-space, so this is ONE query per space the caller holds a
  // connection in (never per connection, never per integration), written in
  // the query builder so the predicate is CONJOINED rather than hand-copied
  // into SQL — a hand copy is the drift this rule exists to remove.
  const spaceOrg = new Map(rows.map((r) => [r.spaceId, r.orgId]));
  const wantedPackageIds = new Set(uniquePackageIds);
  const reuseCount = new Map<string, number>();
  if (wantedPackageIds.size > 0) {
    const perSpace = await Promise.all(
      [...spaceOrg].map(async ([spaceId, orgId]) => {
        const agents = await db
          .select({ integrationIds: declaredIntegrationIds })
          .from(packages)
          .leftJoin(spacePackages, placementRowJoin(packages.id, spaceId))
          .leftJoin(packageShares, placementShareJoin(packages.id, spaceId))
          .where(
            and(
              eq(packages.type, "agent"),
              orgOrSystemFilter(orgId),
              notEphemeralFilter(),
              activeHereSql(spaceId),
            ),
          );
        return { spaceId, agents };
      }),
    );
    for (const { spaceId, agents } of perSpace) {
      for (const agent of agents) {
        for (const integrationId of agent.integrationIds ?? []) {
          if (!wantedPackageIds.has(integrationId)) continue;
          const key = `${spaceId}|${integrationId}`;
          reuseCount.set(key, (reuseCount.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const locks = await connectionLocks(
    db,
    rows.map((r) => r.connectionId),
  );

  // Group by integration package
  const groups = new Map<string, MeConnectionSourceGroup>();
  for (const row of rows) {
    const orgName = orgNameMap.get(row.orgId);
    if (!orgName) continue; // membership filtered out

    let group = groups.get(row.packageId);
    if (!group) {
      const info = packageInfo.get(row.packageId);
      group = {
        kind: "integration",
        source_id: row.packageId,
        display_name: info?.displayName ?? row.packageId,
        logo: info?.logo ?? "",
        total_connections: 0,
        connections: [],
      };
      groups.set(row.packageId, group);
    }

    const claims = asRecord(row.identityClaims);
    const identity =
      typeof claims.account_email === "string"
        ? claims.account_email
        : typeof claims.email === "string"
          ? claims.email
          : typeof claims.sub === "string"
            ? claims.sub
            : row.accountId;

    const entry: MeConnectionEntry = {
      connection_id: row.connectionId,
      kind: "integration",
      label: row.label,
      scopes_granted: row.scopesGranted ?? [],
      connected_at: toISORequired(row.createdAt),
      needs_reconnection: row.needsReconnection,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      identity,
      auth_key: row.authKey,
      shared_with_org: row.sharedWithOrg,
      locked_by: locks.get(row.connectionId) ?? null,
      reused_by_agents: reuseCount.get(`${row.spaceId}|${row.packageId}`) ?? 0,
      org: { id: row.orgId, name: orgName },
      space: { id: row.spaceId, name: row.spaceName },
    };
    group.connections.push(entry);
    group.total_connections += 1;
  }

  return [...groups.values()];
}

/**
 * Unified user-scope listing of integration connection groups, sorted
 * alphabetically by display name. `authority` is required — the route derives
 * it from the principal's kind, so a bound credential is scoped to its own
 * binding while a `user` principal keeps the cross-org dashboard view.
 */
export async function listMeConnections(
  actor: Actor,
  authority: MeConnectionAuthority,
): Promise<MeConnectionSourceGroup[]> {
  const integrations = await listAllActorIntegrationConnections(actor, authority);
  integrations.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return integrations;
}

/** One of the caller's member pins that deleting a connection would shrink. */
interface OwnPinHoldingConnection {
  agent_package_id: string;
  agent_display_name: string;
  integration_package_id: string;
  /** Size of the stored set today; the delete leaves `connection_count - 1` (0 drops the pin). */
  connection_count: number;
}

/** One of the caller's schedules whose override set for an integration names the connection. */
interface OwnScheduleHoldingConnection {
  scheduleId: string;
  schedule_name: string | null;
  agent_package_id: string;
  agent_display_name: string;
  integration_package_id: string;
  /**
   * Size of that set today; the delete leaves `connection_count - 1`. 0 drops the integration's
   * override and disables the schedule (never a silent fall-back for an unattended run).
   */
  connection_count: number;
  /** True when the delete disables this schedule: it is enabled and one of its sets empties. */
  disables: boolean;
}

/** Everything of the caller's that deleting a connection rewrites. */
export interface ConnectionDeleteImpact {
  pins: OwnPinHoldingConnection[];
  schedules: OwnScheduleHoldingConnection[];
  /** How many enabled schedules of other actors name the connection: the delete disables them. */
  other_schedules_disabled_count: number;
}

/** The impact of a delete that rewrites nothing the caller may see; a fresh value each call. */
export function noConnectionDeleteImpact(): ConnectionDeleteImpact {
  return { pins: [], schedules: [], other_schedules_disabled_count: 0 };
}

/**
 * The plan `deleteIntegrationConnection` applies ({@link planConnectionForget}), one entry per pin
 * and per (schedule, integration) naming `connectionId`, plus the number of other actors' schedules
 * it disables. Empty for an unknown connection, one the caller does not own, or one outside a bound
 * credential's org (and space); a bound credential sees only the schedules of its org (and space),
 * though the delete rewrites the others too. A pinned connection is listed: its delete is a 409.
 */
export async function getConnectionDeleteImpact(
  actor: Actor,
  connectionId: string,
  authority: MeConnectionAuthority,
): Promise<ConnectionDeleteImpact> {
  const [row] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .innerJoin(spaces, eq(spaces.id, integrationConnections.spaceId))
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        actorFilter(actor, integrationConnections),
        authorityFilter(authority, spaces.orgId, integrationConnections.spaceId),
      ),
    )
    .limit(1);
  if (!row) return noConnectionDeleteImpact();
  // Member pins need no such filter: a pin write requires its connections in the pin's own space.
  const plan = await planConnectionForget(
    db,
    { id: row.id, owner: actor },
    { scheduleFilter: authorityFilter(authority, schedules.orgId, schedules.spaceId) },
  );
  const agentIds = [...new Set([...plan.pins, ...plan.schedules].map((r) => r.agentPackageId))];
  const agents =
    agentIds.length === 0
      ? []
      : await db
          .select({ id: packages.id, draftManifest: packages.draftManifest })
          .from(packages)
          .where(inArray(packages.id, agentIds));
  const displayNames = new Map(agents.map((pkg) => [pkg.id, getPackageDisplayName(pkg)]));
  // The id stands in for an agent deleted between the two reads.
  const displayName = (id: string) => displayNames.get(id) ?? id;
  return {
    pins: plan.pins.map((pin) => ({
      agent_package_id: pin.agentPackageId,
      agent_display_name: displayName(pin.agentPackageId),
      integration_package_id: pin.integrationId,
      connection_count: pin.connectionIds.length,
    })),
    schedules: plan.schedules.flatMap((schedule) =>
      schedule.entries.map((entry) => ({
        scheduleId: schedule.id,
        schedule_name: schedule.name,
        agent_package_id: schedule.agentPackageId,
        agent_display_name: displayName(schedule.agentPackageId),
        integration_package_id: entry.integrationId,
        connection_count: entry.connectionCount,
        disables: schedule.disables,
      })),
    ),
    other_schedules_disabled_count: plan.foreignScheduleIds.length,
  };
}
