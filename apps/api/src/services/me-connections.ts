// SPDX-License-Identifier: Apache-2.0

/**
 * Unified user-scope connection aggregator backing `GET /api/me/connections`.
 *
 * Returns integration connections in a single shape, grouped by their
 * "source" (the package they connect to).
 *
 * Scope depends on the caller's AUTHORITY, not just their identity:
 *   - Interactive user credentials (dashboard cookie session, OAuth
 *     dashboard/instance JWT) cross orgs and applications — the connection
 *     list belongs to the user, not to any single org context.
 *   - An API key authenticates as its CREATOR but is bound to one org +
 *     one application; its listing is hard-scoped to that (org, app) pair
 *     at the SQL level so a leaked key can never enumerate the creator's
 *     connections in other orgs/apps ({@link MeConnectionAuthority}).
 */

import { db, toRows } from "@appstrate/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  applicationPackages,
  integrationConnections,
  organizationMembers,
  organizations,
  packages,
  applications,
} from "@appstrate/db/schema";
import { actorFilter, type Actor } from "../lib/actor.ts";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";
import { asRecord } from "@appstrate/core/safe-json";
import { toISORequired } from "../lib/date-helpers.ts";
import { getPackageDisplayName } from "../lib/package-helpers.ts";

/**
 * The authority boundary of the credential presented on `/api/me/connections`.
 *
 * REQUIRED on every read/delete path of this module so the scoping decision
 * is made explicitly at the callsite and lands in the SQL `WHERE` — a caller
 * cannot "forget" to scope an API key.
 *
 *   - `user_global`: an interactive user credential (cookie session, OAuth
 *     dashboard/instance JWT). Cross-org, cross-app by design — that is the
 *     dashboard connections-management feature.
 *   - `app_scoped`: an application-bound credential (API key). The key
 *     authenticates as its creator, but its blast radius is one org + one
 *     application; the listing is filtered to that pair at the DB level.
 */
export type MeConnectionAuthority =
  | { kind: "user_global" }
  | { kind: "app_scoped"; orgId: string; applicationId: string };

/**
 * Fetch every integration_connections row owned by the actor, joined with
 * its application + integration package. Cross-app, cross-org for a
 * `user_global` authority; pinned to the authority's (org, application)
 * pair for `app_scoped` callers.
 */
async function listAllActorIntegrationConnections(
  actor: Actor,
  authority: MeConnectionAuthority,
): Promise<MeConnectionSourceGroup[]> {
  const ownerPredicate = actorFilter(actor, integrationConnections);
  // Authority scope lands in the WHERE clause itself (not a post-filter):
  // an app-scoped credential can only ever SELECT rows of its own
  // (org, application) pair.
  const authorityPredicates =
    authority.kind === "app_scoped"
      ? [
          eq(integrationConnections.applicationId, authority.applicationId),
          eq(applications.orgId, authority.orgId),
        ]
      : [];

  const rows = await db
    .select({
      connectionId: integrationConnections.id,
      packageId: integrationConnections.integrationId,
      authKey: integrationConnections.authKey,
      accountId: integrationConnections.accountId,
      applicationId: integrationConnections.applicationId,
      applicationName: applications.name,
      orgId: applications.orgId,
      scopesGranted: integrationConnections.scopesGranted,
      needsReconnection: integrationConnections.needsReconnection,
      expiresAt: integrationConnections.expiresAt,
      label: integrationConnections.label,
      sharedWithOrg: integrationConnections.sharedWithOrg,
      identityClaims: integrationConnections.identityClaims,
      createdAt: integrationConnections.createdAt,
    })
    .from(integrationConnections)
    .innerJoin(applications, eq(integrationConnections.applicationId, applications.id))
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

  // Count installed agents per (application, integration) that declare this
  // integration in their dependencies. One scan over the unique (app, pkg)
  // pairs the user has connections to — single round trip.
  //
  // Use explicit `IN (...)` with `sql.join` instead of `= ANY(${arr})`:
  // when Drizzle's sql-template binds a JS array, postgres.js wraps it as a
  // single text param ("a,b,c") so PG sees `ANY('a,b,c')` and errors out.
  // `sql.join` expands each element to its own parameter — round-trip safe
  // with both PGlite and postgres-js.
  const uniqueAppIds = [...new Set(rows.map((r) => r.applicationId))];
  const reuseCount = new Map<string, number>();
  if (uniqueAppIds.length > 0 && uniquePackageIds.length > 0) {
    const appIdList = sql.join(
      uniqueAppIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const pkgIdList = sql.join(
      uniquePackageIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const countRows = toRows<{ app_id: string; integration_id: string; agent_count: number }>(
      await db.execute(sql`
        SELECT ap.application_id AS app_id,
               keys.integ AS integration_id,
               COUNT(*)::int AS agent_count
        FROM ${applicationPackages} ap
        INNER JOIN ${packages} p ON p.id = ap.package_id AND p.type = 'agent'
        INNER JOIN LATERAL jsonb_object_keys(
          COALESCE(p.draft_manifest -> 'dependencies' -> 'integrations', '{}'::jsonb)
        ) AS keys(integ) ON TRUE
        WHERE ap.application_id IN (${appIdList})
          AND keys.integ IN (${pkgIdList})
        GROUP BY ap.application_id, keys.integ
      `),
    );
    for (const r of countRows) {
      reuseCount.set(`${r.app_id}|${r.integration_id}`, r.agent_count);
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
      reused_by_agents: reuseCount.get(`${row.applicationId}|${row.packageId}`) ?? 0,
      org: { id: row.orgId, name: orgName },
      application: { id: row.applicationId, name: row.applicationName },
    };
    group.connections.push(entry);
    group.total_connections += 1;
  }

  return [...groups.values()];
}

/**
 * Unified user-scope listing of integration connection groups, sorted
 * alphabetically by display name. `authority` is required — the route
 * derives it from the authentication method so an application-bound
 * credential (API key) is scoped to its own (org, application) pair
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
