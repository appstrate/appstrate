import { db } from "../../lib/db.ts";
import type { UserConnectionItem, ProviderDisplayInfo } from "@appstrate/shared-types";
import { eq, and, or, isNull } from "drizzle-orm";
import {
  serviceConnections,
  connectionProfiles,
  organizationMembers,
  organizations,
  packages,
} from "@appstrate/db/schema";
import {
  listConnections as listConnectionsRaw,
  listProviders,
  getProviderAuthMode as getProviderAuthModeRaw,
} from "@appstrate/connect";
import { authModeLabel } from "./helpers.ts";

export interface IntegrationWithStatus {
  uniqueKey: string;
  provider: string;
  displayName: string;
  logo: string;
  status: "connected" | "not_connected" | "needs_reconnection";
  authMode?: string;
  connectionId?: string;
  connectedAt?: string;
}

export async function getProviderAuthMode(
  provider: string,
  orgId: string,
): Promise<string | undefined> {
  return getProviderAuthModeRaw(db, orgId, provider);
}

export async function getIntegrationsWithStatus(
  profileId: string,
  orgId: string,
): Promise<IntegrationWithStatus[]> {
  const [providers, connections] = await Promise.all([
    listProviders(db, orgId),
    listConnectionsRaw(db, profileId),
  ]);

  return providers.map((provider) => {
    const conn = connections.find((c) => c.providerId === provider.id);
    if (conn) {
      return {
        uniqueKey: provider.id,
        provider: provider.id,
        displayName: provider.displayName,
        logo: provider.iconUrl ?? "",
        status: "connected" as const,
        authMode: authModeLabel(provider.authMode),
        connectionId: conn.id,
        connectedAt: conn.createdAt,
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

export async function listAllUserConnections(userId: string): Promise<{
  connections: UserConnectionItem[];
  providerInfo: Record<string, ProviderDisplayInfo>;
}> {
  // 1. Fetch connections
  const rows = await db
    .select({
      connectionId: serviceConnections.id,
      providerId: serviceConnections.providerId,
      scopesGranted: serviceConnections.scopesGranted,
      connectedAt: serviceConnections.createdAt,
      profileId: connectionProfiles.id,
      profileName: connectionProfiles.name,
      isDefault: connectionProfiles.isDefault,
    })
    .from(serviceConnections)
    .innerJoin(connectionProfiles, eq(serviceConnections.profileId, connectionProfiles.id))
    .where(eq(connectionProfiles.userId, userId));

  // 2. Fetch user's orgs
  const userOrgs = await db
    .select({
      orgId: organizationMembers.orgId,
      orgName: organizations.name,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.orgId, organizations.id))
    .where(eq(organizationMembers.userId, userId));

  // 3. For each org, get provider IDs from packages table
  const orgProviders = new Map<string, { name: string; providerIds: Set<string> }>();
  for (const org of userOrgs) {
    const pkgRows = await db
      .select({ id: packages.id })
      .from(packages)
      .where(
        and(
          or(eq(packages.orgId, org.orgId), isNull(packages.orgId)),
          eq(packages.type, "provider"),
        ),
      );
    const providerIds = new Set(pkgRows.map((r) => r.id));
    orgProviders.set(org.orgId, { name: org.orgName, providerIds });
  }

  // 4. Build connections with org matching
  const connections: UserConnectionItem[] = rows.map((r) => {
    const orgs: UserConnectionItem["orgs"] = [];
    for (const [orgId, { name, providerIds }] of orgProviders) {
      if (providerIds.has(r.providerId)) {
        orgs.push({
          id: orgId,
          name,
          status: "valid",
        });
      }
    }
    return {
      connectionId: r.connectionId,
      providerId: r.providerId,
      authMode: "",
      scopesGranted: r.scopesGranted ?? [],
      connectedAt: r.connectedAt?.toISOString() ?? "",
      profile: { id: r.profileId, name: r.profileName, isDefault: r.isDefault },
      orgs,
    };
  });

  // 5. Provider display info from packages table
  const uniqueProviderIds = [...new Set(rows.map((r) => r.providerId))];
  const providerInfo: Record<string, ProviderDisplayInfo> = {};
  if (uniqueProviderIds.length > 0) {
    for (const org of userOrgs) {
      const pkgRows = await db
        .select({ id: packages.id, manifest: packages.manifest })
        .from(packages)
        .where(
          and(
            or(eq(packages.orgId, org.orgId), isNull(packages.orgId)),
            eq(packages.type, "provider"),
          ),
        );
      for (const pkg of pkgRows) {
        if (!providerInfo[pkg.id]) {
          const manifest = (pkg.manifest ?? {}) as Record<string, unknown>;
          providerInfo[pkg.id] = {
            displayName: (manifest.displayName as string) ?? pkg.id,
            logo: (manifest.iconUrl as string) ?? "",
          };
        }
      }
    }
    // Fill in any missing providers
    for (const pid of uniqueProviderIds) {
      if (!providerInfo[pid]) {
        providerInfo[pid] = { displayName: pid, logo: "" };
      }
    }
  }

  return { connections, providerInfo };
}
