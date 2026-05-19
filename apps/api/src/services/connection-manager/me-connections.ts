// SPDX-License-Identifier: Apache-2.0

/**
 * Unified user-scope connection aggregator backing `GET /api/me/connections`.
 *
 * Returns both provider connections and integration connections in a single
 * shape, grouped by their "source" (the package they connect to). Crosses
 * orgs and applications — the connection list belongs to the user, not to
 * any single org context.
 */

import { db } from "@appstrate/db/client";
import { eq, inArray, sql } from "drizzle-orm";
import {
  applicationPackages,
  integrationConnections,
  organizationMembers,
  organizations,
  packages,
  applications,
} from "@appstrate/db/schema";
import type { Actor } from "../../lib/actor.ts";
import type { MeConnectionEntry, MeConnectionSourceGroup } from "@appstrate/shared-types";
import { asRecord } from "@appstrate/core/safe-json";
import { toISORequired } from "../../lib/date-helpers.ts";
import { getPackageDisplayName } from "../../lib/package-helpers.ts";
import { listAllActorConnections } from "./providers.ts";

/**
 * Fetch every integration_connections row owned by the actor, joined with
 * its application + integration package. Cross-app, cross-org.
 */
async function listAllActorIntegrationConnections(
  actor: Actor,
): Promise<MeConnectionSourceGroup[]> {
  const ownerPredicate =
    actor.type === "user"
      ? eq(integrationConnections.userId, actor.id)
      : eq(integrationConnections.endUserId, actor.id);

  const rows = await db
    .select({
      connectionId: integrationConnections.id,
      packageId: integrationConnections.integrationPackageId,
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
    .where(ownerPredicate);

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
      logo:
        typeof manifest.iconUrl === "string"
          ? manifest.iconUrl
          : typeof manifest.icon === "string"
            ? manifest.icon
            : "",
    });
  }

  // Count installed agents per (application, integration) that declare this
  // integration in their dependencies. One scan over the unique (app, pkg)
  // pairs the user has connections to — single round trip.
  const uniqueAppIds = [...new Set(rows.map((r) => r.applicationId))];
  const reuseCount = new Map<string, number>();
  if (uniqueAppIds.length > 0 && uniquePackageIds.length > 0) {
    const countRows = (await db.execute(sql`
      SELECT ap.application_id AS app_id,
             keys.integ AS integration_id,
             COUNT(*)::int AS agent_count
      FROM ${applicationPackages} ap
      INNER JOIN ${packages} p ON p.id = ap.package_id AND p.type = 'agent'
      INNER JOIN LATERAL jsonb_object_keys(
        COALESCE(p.draft_manifest -> 'dependencies' -> 'integrations', '{}'::jsonb)
      ) AS keys(integ) ON TRUE
      WHERE ap.application_id = ANY(${uniqueAppIds})
        AND keys.integ = ANY(${uniquePackageIds})
      GROUP BY ap.application_id, keys.integ
    `)) as unknown as { app_id: string; integration_id: string; agent_count: number }[];
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
        sourceId: row.packageId,
        displayName: info?.displayName ?? row.packageId,
        logo: info?.logo ?? "",
        totalConnections: 0,
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
      connectionId: row.connectionId,
      kind: "integration",
      label: row.label,
      scopesGranted: row.scopesGranted ?? [],
      connectedAt: toISORequired(row.createdAt),
      needsReconnection: row.needsReconnection,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      identity,
      profile: null,
      authKey: row.authKey,
      sharedWithOrg: row.sharedWithOrg,
      reusedByAgents: reuseCount.get(`${row.applicationId}|${row.packageId}`) ?? 0,
      org: { id: row.orgId, name: orgName },
      application: { id: row.applicationId, name: row.applicationName },
    };
    group.connections.push(entry);
    group.totalConnections += 1;
  }

  return [...groups.values()];
}

/**
 * Convert the legacy `UserConnectionProviderGroup[]` shape into the unified
 * `MeConnectionSourceGroup[]` shape. Provider connections don't carry
 * `needsReconnection` / `expiresAt` / `label` at this listing layer — we
 * surface what's available.
 */
async function listAllActorProviderConnectionsUnified(
  actor: Actor,
): Promise<MeConnectionSourceGroup[]> {
  const legacy = await listAllActorConnections(actor);
  const groups: MeConnectionSourceGroup[] = [];
  for (const pg of legacy.data) {
    const connections: MeConnectionEntry[] = [];
    for (const og of pg.orgs) {
      for (const conn of og.connections) {
        connections.push({
          connectionId: conn.connectionId,
          kind: "provider",
          label: null,
          scopesGranted: conn.scopesGranted ?? [],
          connectedAt: conn.connectedAt,
          needsReconnection: false,
          expiresAt: null,
          identity: conn.profile.name,
          profile: conn.profile,
          authKey: null,
          sharedWithOrg: false,
          reusedByAgents: null,
          org: { id: og.orgId, name: og.orgName },
          application: conn.application,
        });
      }
    }
    if (connections.length === 0) continue;
    groups.push({
      kind: "provider",
      sourceId: pg.providerId,
      displayName: pg.displayName,
      logo: pg.logo,
      totalConnections: connections.length,
      connections,
    });
  }
  return groups;
}

/**
 * Unified user-scope listing. Provider groups first, then integration groups,
 * sorted alphabetically by display name within each kind.
 */
export async function listMeConnections(actor: Actor): Promise<MeConnectionSourceGroup[]> {
  const [providers, integrations] = await Promise.all([
    listAllActorProviderConnectionsUnified(actor),
    listAllActorIntegrationConnections(actor),
  ]);
  const sortByName = (a: MeConnectionSourceGroup, b: MeConnectionSourceGroup) =>
    a.displayName.localeCompare(b.displayName);
  providers.sort(sortByName);
  integrations.sort(sortByName);
  return [...providers, ...integrations];
}
