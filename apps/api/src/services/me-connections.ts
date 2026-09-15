// SPDX-License-Identifier: Apache-2.0

/**
 * Unified user-scope connection aggregator backing `GET /api/me/connections`.
 *
 * Returns integration connections in a single shape, grouped by their
 * "source" (the package they connect to).
 *
 * Scope depends on the caller's AUTHORITY, not just their identity:
 *   - Interactive user credentials (dashboard cookie session, OAuth
 *     dashboard/instance JWT) cross orgs and spaces — the connection
 *     list belongs to the user, not to any single org context.
 *   - An API key authenticates as its CREATOR but is bound to one org +
 *     one space; its listing is hard-scoped to that (org, space) pair
 *     at the SQL level so a leaked key can never enumerate the creator's
 *     connections in other orgs/spaces ({@link MeConnectionAuthority}).
 */

import { db } from "@appstrate/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  spacePackages,
  packageShares,
  integrationConnections,
  organizationMembers,
  organizations,
  packages,
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

/**
 * The authority boundary of the credential presented on `/api/me/connections`.
 *
 * REQUIRED on every read/delete path of this module so the scoping decision
 * is made explicitly at the callsite and lands in the SQL `WHERE` — a caller
 * cannot "forget" to scope an API key.
 *
 *   - `user_global`: an interactive user credential (cookie session, OAuth
 *     dashboard/instance JWT). Cross-org, cross-space by design — that is the
 *     dashboard connections-management feature.
 *   - `space_scoped`: a space-bound credential (API key). The key
 *     authenticates as its creator, but its blast radius is one org + one
 *     space; the listing is filtered to that pair at the DB level.
 */
export type MeConnectionAuthority =
  { kind: "user_global" } | { kind: "space_scoped"; orgId: string; spaceId: string };

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
 * `user_global` authority; pinned to the authority's (org, space)
 * pair for `space_scoped` callers.
 */
async function listAllActorIntegrationConnections(
  actor: Actor,
  authority: MeConnectionAuthority,
): Promise<MeConnectionSourceGroup[]> {
  const ownerPredicate = actorFilter(actor, integrationConnections);
  // Authority scope lands in the WHERE clause itself (not a post-filter):
  // a space-scoped credential can only ever SELECT rows of its own
  // (org, space) pair.
  const authorityPredicates =
    authority.kind === "space_scoped"
      ? [eq(integrationConnections.spaceId, authority.spaceId), eq(spaces.orgId, authority.orgId)]
      : [];

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
    .where(and(ownerPredicate, ...authorityPredicates));

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
          .leftJoin(
            spacePackages,
            and(eq(spacePackages.packageId, packages.id), eq(spacePackages.spaceId, spaceId)),
          )
          .leftJoin(
            packageShares,
            and(eq(packageShares.packageId, packages.id), eq(packageShares.spaceId, spaceId)),
          )
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
      typeof claims.accountEmail === "string"
        ? claims.accountEmail
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
 * alphabetically by display name. `authority` is required — the route
 * derives it from the authentication method so a space-bound
 * credential (API key) is scoped to its own (org, space) pair
 * while interactive user credentials keep the cross-org dashboard view.
 */
export async function listMeConnections(
  actor: Actor,
  authority: MeConnectionAuthority,
): Promise<MeConnectionSourceGroup[]> {
  const integrations = await listAllActorIntegrationConnections(actor, authority);
  integrations.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return integrations;
}
