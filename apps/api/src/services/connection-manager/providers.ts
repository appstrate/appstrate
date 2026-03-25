import { db } from "../../lib/db.ts";
import type { UserConnectionProviderGroup } from "@appstrate/shared-types";
import { eq, inArray } from "drizzle-orm";
import {
  userProviderConnections,
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
import { type Actor, actorFilter } from "../../lib/actor.ts";
import { authModeLabel } from "./helpers.ts";

export interface AvailableProviderWithStatus {
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

export async function getAvailableProvidersWithStatus(
  profileId: string,
  orgId: string,
): Promise<AvailableProviderWithStatus[]> {
  const [providers, connections] = await Promise.all([
    listProviders(db, orgId),
    listConnectionsRaw(db, profileId, orgId),
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

export async function listAllActorConnections(
  actor: Actor,
): Promise<{ providers: UserConnectionProviderGroup[] }> {
  // 1. Fetch all actor connections with org info
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
    })
    .from(userProviderConnections)
    .innerJoin(connectionProfiles, eq(userProviderConnections.profileId, connectionProfiles.id))
    .where(
      actorFilter(actor, {
        userId: connectionProfiles.userId,
        endUserId: connectionProfiles.endUserId,
      }),
    );

  if (rows.length === 0) return { providers: [] };

  // 2. Fetch org names (for members, use organizationMembers; for end_users, derive from connections)
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

  // 3. Fetch provider display info in a single query
  const uniqueProviderIds = [...new Set(rows.map((r) => r.providerId))];
  const providerPkgs = await db
    .select({ id: packages.id, draftManifest: packages.draftManifest })
    .from(packages)
    .where(inArray(packages.id, uniqueProviderIds));

  const providerInfo = new Map<string, { displayName: string; logo: string }>();
  for (const pkg of providerPkgs) {
    const manifest = (
      pkg.draftManifest !== null &&
      typeof pkg.draftManifest === "object" &&
      !Array.isArray(pkg.draftManifest)
        ? pkg.draftManifest
        : {}
    ) as Record<string, unknown>;
    providerInfo.set(pkg.id, {
      displayName: typeof manifest.displayName === "string" ? manifest.displayName : pkg.id,
      logo: typeof manifest.iconUrl === "string" ? manifest.iconUrl : "",
    });
  }

  // 4. Group by provider → org → connections
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

  // 5. Build the response
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
        connectedAt: r.connectedAt?.toISOString() ?? "",
        profile: { id: r.profileId, name: r.profileName, isDefault: r.isDefault },
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
