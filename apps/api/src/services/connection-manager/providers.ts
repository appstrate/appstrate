import { db } from "../../lib/db.ts";
import type { UserConnectionItem, ProviderDisplayInfo } from "@appstrate/shared-types";
import { eq } from "drizzle-orm";
import {
  serviceConnections,
  connectionProfiles,
  organizationMembers,
  organizations,
} from "@appstrate/db/schema";
import {
  listConnections as listConnectionsRaw,
  listProviders,
  getProviderAuthMode as getProviderAuthModeRaw,
  getBuiltInProviders,
} from "@appstrate/connect";
import { computeConfigHash } from "../connection-profiles.ts";
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
    const currentHash = computeConfigHash(provider);
    // Look for exact configHash match first
    const exactConn = connections.find(
      (c) => c.providerId === provider.id && c.configHash === currentHash,
    );
    if (exactConn) {
      return {
        uniqueKey: provider.id,
        provider: provider.id,
        displayName: provider.displayName,
        logo: provider.iconUrl ?? "",
        status: "connected" as const,
        authMode: authModeLabel(provider.authMode),
        connectionId: exactConn.id,
        connectedAt: exactConn.createdAt,
      };
    }
    // Fallback: any connection for this provider → needs reconnection
    const anyConn = connections.find((c) => c.providerId === provider.id);
    return {
      uniqueKey: provider.id,
      provider: provider.id,
      displayName: provider.displayName,
      logo: provider.iconUrl ?? "",
      status: anyConn ? ("needs_reconnection" as const) : ("not_connected" as const),
      authMode: authModeLabel(provider.authMode),
    };
  });
}

export async function listAllUserConnections(userId: string): Promise<{
  connections: UserConnectionItem[];
  providerInfo: Record<string, ProviderDisplayInfo>;
}> {
  // 1. Fetch connections with configHash
  const rows = await db
    .select({
      connectionId: serviceConnections.id,
      providerId: serviceConnections.providerId,
      authMode: serviceConnections.authMode,
      scopesGranted: serviceConnections.scopesGranted,
      connectedAt: serviceConnections.createdAt,
      configHash: serviceConnections.configHash,
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

  // 3. For each org, compute provider hashes (providerId → hash)
  const orgHashes = new Map<string, { name: string; hashes: Map<string, string> }>();
  for (const org of userOrgs) {
    const providers = await listProviders(db, org.orgId);
    const hashes = new Map<string, string>();
    for (const p of providers) {
      hashes.set(p.id, computeConfigHash(p));
    }
    orgHashes.set(org.orgId, { name: org.orgName, hashes });
  }

  // 4. Build connections with org matching
  const connections: UserConnectionItem[] = rows.map((r) => {
    const orgs: UserConnectionItem["orgs"] = [];
    for (const [orgId, { name, hashes }] of orgHashes) {
      const orgProviderHash = hashes.get(r.providerId);
      if (orgProviderHash !== undefined) {
        orgs.push({
          id: orgId,
          name,
          status: orgProviderHash === r.configHash ? "valid" : "needs_reconnection",
        });
      }
    }
    return {
      connectionId: r.connectionId,
      providerId: r.providerId,
      authMode: r.authMode,
      scopesGranted: r.scopesGranted ?? [],
      connectedAt: r.connectedAt?.toISOString() ?? "",
      profile: { id: r.profileId, name: r.profileName, isDefault: r.isDefault },
      orgs,
    };
  });

  // 5. Provider display info
  const uniqueProviderIds = [...new Set(rows.map((r) => r.providerId))];
  const builtIn = getBuiltInProviders();
  const providerInfo: Record<string, ProviderDisplayInfo> = {};
  for (const pid of uniqueProviderIds) {
    const p = builtIn.get(pid);
    providerInfo[pid] = {
      displayName: p?.displayName ?? pid,
      logo: p?.iconUrl ?? "",
    };
  }

  return { connections, providerInfo };
}
