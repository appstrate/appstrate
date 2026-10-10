// SPDX-License-Identifier: Apache-2.0

/**
 * Unified user-scope connection aggregator backing `GET /api/me/connections`.
 *
 * Returns integration connections in a single shape, grouped by their
 * "source" (the package they connect to).
 *
 * Scope depends on the caller's principal, not just their identity:
 *   - A `person` principal crosses orgs and spaces — the connection list
 *     belongs to the person, not to any single org context.
 *   - A `delegated` principal authenticates as its issuer but is bound; its
 *     listing is hard-scoped to that binding at the SQL level so a leaked
 *     credential can never enumerate the issuer's connections elsewhere
 *     ({@link ConnectionPrincipal}).
 */

import { db } from "@appstrate/db/client";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  spacePackages,
  packageShares,
  integrationConnections,
  integrationPins,
  organizationMembers,
  organizations,
  packages,
  schedules,
  spaces,
} from "@appstrate/db/schema";
import { actorFilter, type Actor } from "../lib/actor.ts";
import { displayAccountId } from "../lib/connection-identity.ts";
import type { ConnectionPrincipal } from "../lib/connection-principal.ts";
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
import {
  connectionLocks,
  connectionReach,
  connectionViewOf,
  loadConnectionShares,
  planConnectionForget,
} from "./integration-connections.ts";
import {
  connectionActions,
  meConnectionAuthorityFilter,
  usableInSpace,
  type ConnectionCaller,
} from "./connection-reach.ts";
import { shareableSpaces } from "./connection-shares.ts";
import { listSpacesForPrincipal } from "./spaces.ts";
import { spacePermissions } from "../lib/space-role.ts";
import type { OrgRole } from "@appstrate/core/permissions";

/** The same binding over `schedules`, which carry both columns. */
function scheduleAuthorityFilter(principal: ConnectionPrincipal): SQL | undefined {
  if (principal.kind !== "delegated") return undefined;
  return and(
    eq(schedules.orgId, principal.orgId),
    principal.spaceId ? eq(schedules.spaceId, principal.spaceId) : undefined,
  );
}

/** Its space over member pins — a pin of the connection is in the connection's org already. */
function pinAuthorityFilter(principal: ConnectionPrincipal): SQL | undefined {
  return principal.kind === "delegated" && principal.spaceId
    ? eq(integrationPins.spaceId, principal.spaceId)
    : undefined;
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
 * For each of the user's rows, the spaces they run agents in (`agents:run`) where the row is
 * {@link usableInSpace}: one listing per org, one query per space, never one per connection.
 */
async function spacesServedToOwner(
  actor: Actor,
  orgRoles: ReadonlyMap<string, OrgRole>,
): Promise<{ byConnection: Map<string, string[]>; orgOfSpace: Map<string, string> }> {
  const byConnection = new Map<string, string[]>();
  const orgOfSpace = new Map<string, string>();
  if (actor.type !== "user") return { byConnection, orgOfSpace };
  const listed = await Promise.all(
    [...orgRoles].map(([orgId, role]) => listSpacesForPrincipal(orgId, role, actor.id, actor.id)),
  );
  const runnable = listed
    .flat()
    .filter(({ role }) => spacePermissions(role).has("agents:run"))
    .map(({ space }) => space);
  await Promise.all(
    runnable.map(async (space) => {
      const usable = await db
        .select({ id: integrationConnections.id })
        .from(integrationConnections)
        .where(and(usableInSpace(space.id, actor), actorFilter(actor, integrationConnections)));
      if (usable.length > 0) orgOfSpace.set(space.id, space.orgId);
      for (const { id } of usable) {
        byConnection.set(id, [...(byConnection.get(id) ?? []), space.id]);
      }
    }),
  );
  return { byConnection, orgOfSpace };
}

/**
 * Every connection the caller owns, within its credential's binding, grouped by integration; the
 * connections of a group keep the order of the query. The route derives the principal from the
 * credential, so a delegated credential is scoped to its own binding while a `person` principal
 * keeps the cross-org dashboard view. Groups sorted by display name.
 */
export async function listMeConnections(
  caller: ConnectionCaller,
): Promise<MeConnectionSourceGroup[]> {
  const principal = caller.principal;
  const actor = principal.actor;
  const rows = await db
    .select({
      connectionId: integrationConnections.id,
      packageId: integrationConnections.integrationId,
      authKey: integrationConnections.authKey,
      accountId: integrationConnections.accountId,
      orgId: integrationConnections.orgId,
      userId: integrationConnections.userId,
      endUserId: integrationConnections.endUserId,
      spaceId: integrationConnections.spaceId,
      originSpaceId: integrationConnections.originSpaceId,
      scopesGranted: integrationConnections.scopesGranted,
      needsReconnection: integrationConnections.needsReconnection,
      expiresAt: integrationConnections.expiresAt,
      label: integrationConnections.label,
      identityClaims: integrationConnections.identityClaims,
      createdAt: integrationConnections.createdAt,
    })
    .from(integrationConnections)
    .where(and(actorFilter(actor, integrationConnections), meConnectionAuthorityFilter(principal)));

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
  const orgRoles = new Map<string, OrgRole>();
  if (actor.type === "user") {
    const memberOrgs = await db
      .select({ orgId: organizationMembers.orgId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, actor.id));
    const memberRoles = new Map(memberOrgs.map((m) => [m.orgId, m.role]));
    for (const id of uniqueOrgIds) {
      const role = memberRoles.get(id);
      if (role) orgRoles.set(id, role);
      else orgNameMap.delete(id);
    }
  }

  const shares = await loadConnectionShares(
    db,
    rows.map((r) => r.connectionId),
  );
  const reaches = new Map(
    rows.map((r) => [
      r.connectionId,
      connectionReach(r, connectionViewOf(principal, r, null, shares.get(r.connectionId) ?? [])),
    ]),
  );
  // The shares each row's caller sees (all of them, or its bound space's).
  const sharesOf = (connectionId: string) => reaches.get(connectionId)!.shared_space_ids ?? [];
  // The spaces each row reaches by name: its home (its space, else its origin) and its shares.
  const reachedSpaces = (r: (typeof rows)[number]) => {
    const home = r.spaceId ?? reaches.get(r.connectionId)!.origin_space_id ?? null;
    return [...new Set([...(home ? [home] : []), ...sharesOf(r.connectionId)])];
  };
  const shareable = await shareableSpaces(
    caller,
    rows.map((r) => ({ ...r, id: r.connectionId })),
    orgRoles,
  );
  const uniqueSpaceIds = [...new Set(rows.flatMap(reachedSpaces))];
  const spaceRows =
    uniqueSpaceIds.length === 0
      ? []
      : await db
          .select({ id: spaces.id, name: spaces.name, orgId: spaces.orgId })
          .from(spaces)
          .where(inArray(spaces.id, uniqueSpaceIds));
  const spaceById = new Map(spaceRows.map((sp) => [sp.id, sp]));
  const spaceRef = (id: string | null) => {
    const sp = id ? spaceById.get(id) : undefined;
    return sp ? { id: sp.id, name: sp.name } : null;
  };

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

  // Where a row serves agents: for the owner, every space they run in that it is usable in; for a
  // delegated credential, its home and shares within the binding. Share targets count either way.
  const served =
    principal.kind === "person"
      ? await spacesServedToOwner(actor, orgRoles)
      : { byConnection: new Map<string, string[]>(), orgOfSpace: new Map<string, string>() };
  const servingSpaces = (r: (typeof rows)[number]) =>
    principal.kind === "person"
      ? [
          ...new Set([
            ...(served.byConnection.get(r.connectionId) ?? []),
            ...sharesOf(r.connectionId),
          ]),
        ]
      : reachedSpaces(r);
  const orgOfSpace = new Map([
    ...spaceRows.map((sp) => [sp.id, sp.orgId] as const),
    ...served.orgOfSpace,
  ]);
  const countedSpaces = [...new Set(rows.flatMap(servingSpaces))].flatMap((id) => {
    const orgId = orgOfSpace.get(id);
    return orgId ? [{ id, orgId }] : [];
  });

  // Count the agents each space RUNS that declare this integration in their
  // dependencies — "reused by N agents" is a statement about runs, so the
  // question is the ONE activation rule ({@link activeHereSql}) and not the
  // presence of a `space_packages` row: a deactivated agent, and an ORPHAN row
  // naming a package the space has lost, execute nowhere and reuse nothing.
  //
  // That rule is per-space, so this is ONE query per space a row serves
  // (never per connection, never per integration), written in
  // the query builder so the predicate is CONJOINED rather than hand-copied
  // into SQL — a hand copy is the drift this rule exists to remove. An agent run
  // in two of a row's spaces is one agent.
  const agentsBySpace = new Map(
    await Promise.all(
      countedSpaces.map(
        async (sp) =>
          [
            sp.id,
            await db
              .select({ id: packages.id, integrationIds: declaredIntegrationIds })
              .from(packages)
              .leftJoin(spacePackages, placementRowJoin(packages.id, sp.id))
              .leftJoin(packageShares, placementShareJoin(packages.id, sp.id))
              .where(
                and(
                  eq(packages.type, "agent"),
                  orgOrSystemFilter(sp.orgId),
                  notEphemeralFilter(),
                  activeHereSql(sp.id),
                ),
              ),
          ] as const,
      ),
    ),
  );
  const reusingAgents = (r: (typeof rows)[number]) =>
    new Set(
      servingSpaces(r).flatMap((spaceId) =>
        (agentsBySpace.get(spaceId) ?? [])
          .filter((agent) => agent.integrationIds?.includes(r.packageId))
          .map((agent) => agent.id),
      ),
    ).size;

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

    const reach = reaches.get(row.connectionId)!;
    const claims = asRecord(row.identityClaims);
    const identity =
      typeof claims.account_email === "string"
        ? claims.account_email
        : typeof claims.email === "string"
          ? claims.email
          : typeof claims.sub === "string"
            ? claims.sub
            : (displayAccountId(row.accountId) ?? row.label);

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
      scope: reach.scope,
      shared_spaces: sharesOf(row.connectionId).flatMap((id) => spaceRef(id) ?? []),
      allowed_actions: connectionActions(row, caller, false),
      shareable_spaces: shareable.get(row.connectionId) ?? [],
      locked_by: locks.get(row.connectionId) ?? null,
      reused_by_agents: reusingAgents(row),
      org: { id: row.orgId, name: orgName },
      space: spaceRef(row.spaceId),
      origin_space: spaceRef(reach.origin_space_id ?? null),
    };
    group.connections.push(entry);
    group.total_connections += 1;
  }

  return [...groups.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
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
 * The plan `deleteOwnConnection` applies ({@link planConnectionForget}), one entry per pin
 * and per (schedule, integration) naming `connectionId`, plus the number of other actors' schedules
 * it disables. Empty for an unknown connection, one the caller does not own, or one outside a bound
 * credential's org (and space); a bound credential sees only the pins and schedules of its org (and
 * space), though the delete rewrites the others too. A pinned connection is listed: its delete is a 409.
 */
export async function getConnectionDeleteImpact(
  principal: ConnectionPrincipal,
  connectionId: string,
): Promise<ConnectionDeleteImpact> {
  const actor = principal.actor;
  const [row] = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(
      and(
        eq(integrationConnections.id, connectionId),
        actorFilter(actor, integrationConnections),
        meConnectionAuthorityFilter(principal),
      ),
    )
    .limit(1);
  if (!row) return noConnectionDeleteImpact();
  const plan = await planConnectionForget(
    db,
    { id: row.id, owner: actor },
    {
      scheduleFilter: scheduleAuthorityFilter(principal),
      pinFilter: pinAuthorityFilter(principal),
    },
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
