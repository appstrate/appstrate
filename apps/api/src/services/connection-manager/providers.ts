// SPDX-License-Identifier: Apache-2.0

import { db } from "@appstrate/db/client";
import type { UserConnectionProviderGroup, AvailableProvider } from "@appstrate/shared-types";
import { eq, inArray } from "drizzle-orm";
import {
  userProviderConnections,
  connectionProfiles,
  organizationMembers,
  organizations,
  packages,
  applicationProviderCredentials,
  applications,
} from "@appstrate/db/schema";
import {
  listConnections as listConnectionsRaw,
  listProviderCredentialIds,
  listConfiguredProviderIds,
  listProviders,
  getProviderAuthMode as getProviderAuthModeRaw,
} from "@appstrate/connect";
import { type Actor, actorFilter } from "../../lib/actor.ts";
import { authModeLabel } from "./helpers.ts";
import { asRecord } from "../../lib/safe-json.ts";
import { toISORequired } from "../../lib/date-helpers.ts";
import { getPackageDisplayName } from "../../lib/package-helpers.ts";

export async function getProviderAuthMode(
  provider: string,
  orgId: string,
): Promise<string | undefined> {
  return getProviderAuthModeRaw(db, orgId, provider);
}

export async function getAvailableProvidersWithStatus(
  profileId: string,
  orgId: string,
  applicationId: string,
): Promise<AvailableProvider[]> {
  const [providers, credentialIds, configuredProviderIds] = await Promise.all([
    listProviders(db, orgId),
    listProviderCredentialIds(db, applicationId),
    listConfiguredProviderIds(db, applicationId),
  ]);
  const connections = await listConnectionsRaw(db, profileId, orgId, credentialIds);
  const configuredSet = new Set(configuredProviderIds);

  return providers
    .filter((provider) => configuredSet.has(provider.id))
    .map((provider) => {
      const conn = connections.find((c) => c.providerId === provider.id);
      if (conn) {
        return {
          uniqueKey: provider.id,
          provider: provider.id,
          displayName: provider.displayName,
          logo: provider.iconUrl ?? "",
          status: conn.needsReconnection ? ("needs_reconnection" as const) : ("connected" as const),
          authMode: authModeLabel(provider.authMode),
          connectionId: conn.id,
          connectedAt: conn.createdAt,
          scopesGranted: conn.scopesGranted,
        };
      }
      return {
        uniqueKey: provider.id,
        provider: provider.id,
        displayName: provider.displayName,
        logo: provider.iconUrl ?? "",
        status: "not_connected" as const,
        authMode: authModeLabel(provider.authMode),
      };
    });
}

export async function listAllActorConnections(
  actor: Actor,
): Promise<{ providers: UserConnectionProviderGroup[] }> {
  // Fetch all actor connections across ALL apps, joining through
  // applicationProviderCredentials → applications to get app context.
  // The preferences page needs to show "Gmail (App A)" vs "Gmail (App B)".
  const rows = await db
    .select({
      connectionId: userProviderConnections.id,
      providerId: userProviderConnections.providerId,
      orgId: userProviderConnections.orgId,
      scopesGranted: userProviderConnections.scopesGranted,
      connectedAt: userProviderConnections.createdAt,
      profileId: connectionProfiles.id,
      profileName: connectionProfiles.name,
      isDefault: connectionProfiles.isDefault,
      applicationId: applicationProviderCredentials.applicationId,
      applicationName: applications.name,
    })
    .from(userProviderConnections)
    .innerJoin(connectionProfiles, eq(userProviderConnections.profileId, connectionProfiles.id))
    .innerJoin(
      applicationProviderCredentials,
      eq(userProviderConnections.providerCredentialId, applicationProviderCredentials.id),
    )
    .innerJoin(applications, eq(applicationProviderCredentials.applicationId, applications.id))
    .where(
      actorFilter(actor, {
        userId: connectionProfiles.userId,
        endUserId: connectionProfiles.endUserId,
      }),
    );

  if (rows.length === 0) return { providers: [] };

  // Fetch org names
  const userOrgs =
    actor.type === "member"
      ? await db
          .select({
            orgId: organizationMembers.orgId,
            orgName: organizations.name,
          })
          .from(organizationMembers)
          .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
          .where(eq(organizationMembers.userId, actor.id))
      : await db
          .select({
            orgId: organizations.id,
            orgName: organizations.name,
          })
          .from(organizations)
          .where(inArray(organizations.id, [...new Set(rows.map((r) => r.orgId))]));

  const orgNameMap = new Map(userOrgs.map((o) => [o.orgId, o.orgName]));

  // Fetch provider display info
  const uniqueProviderIds = [...new Set(rows.map((r) => r.providerId))];
  const providerPkgs = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, uniqueProviderIds));

  const providerInfo = new Map<string, { displayName: string; logo: string }>();
  for (const pkg of providerPkgs) {
    const manifest = asRecord(pkg.draftManifest);
    providerInfo.set(pkg.id, {
      displayName: getPackageDisplayName(pkg),
      logo: typeof manifest.iconUrl === "string" ? manifest.iconUrl : "",
    });
  }

  // Group by provider → org → connections
  const providerMap = new Map<
    string,
    { orgMap: Map<string, typeof rows>; totalConnections: number }
  >();

  for (const row of rows) {
    let pg = providerMap.get(row.providerId);
    if (!pg) {
      pg = { orgMap: new Map(), totalConnections: 0 };
      providerMap.set(row.providerId, pg);
    }
    pg.totalConnections++;

    let orgConns = pg.orgMap.get(row.orgId);
    if (!orgConns) {
      orgConns = [];
      pg.orgMap.set(row.orgId, orgConns);
    }
    orgConns.push(row);
  }

  // Build the response
  const providers: UserConnectionProviderGroup[] = [];
  for (const [providerId, pg] of providerMap) {
    const info = providerInfo.get(providerId);
    const orgs = [...pg.orgMap.entries()].map(([orgId, conns]) => ({
      orgId,
      orgName: orgNameMap.get(orgId) ?? orgId,
      connections: conns.map((r) => ({
        connectionId: r.connectionId,
        scopesGranted: (Array.isArray(r.scopesGranted) &&
        r.scopesGranted.every((v: unknown) => typeof v === "string")
          ? r.scopesGranted
          : []) as string[],
        connectedAt: toISORequired(r.connectedAt),
        profile: { id: r.profileId, name: r.profileName, isDefault: r.isDefault },
        application: { id: r.applicationId, name: r.applicationName },
      })),
    }));

    providers.push({
      providerId,
      displayName: info?.displayName ?? providerId,
      logo: info?.logo ?? "",
      totalConnections: pg.totalConnections,
      orgs,
    });
  }

  return { providers };
}
