// SPDX-License-Identifier: Apache-2.0

/**
 * MCP access grants — one per (user, OAuth client, MCP resource).
 *
 * An MCP client receives tokens audience-bound to one MCP resource: an org
 * endpoint (`/api/mcp/o/:org`) or a space endpoint (`/api/mcp/o/:org/s/:space`).
 * The tokens live in Better Auth's `oauth_refresh_tokens` /
 * `oauth_access_tokens`; `oauth_grant_states` holds what they cannot: the
 * revocation watermark and the last use. A grant groups every live refresh
 * token of its triple (one per authorization), and revoking it ends them all.
 */

import { getErrorMessage } from "@appstrate/core/errors";
import { db } from "@appstrate/db/client";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthGrantState,
  oauthRefreshToken,
  organizations,
  spaces,
} from "@appstrate/db/schema";
import { and, arrayContains, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { parseMcpResourceUri, type McpResourceBinding } from "../../../lib/audiences.ts";
import { logger } from "../../../lib/logger.ts";

/** Lifetime of the access tokens `/oauth2/token` mints (`auth/plugins.ts`). */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** At most one activity write per grant per interval, as for CLI sessions. */
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 1000;

/**
 * Called by the OIDC strategy for every resolved JWT bound to an MCP resource.
 * Refuses a token issued at or before the grant's watermark (`iat` has
 * one-second resolution, so a token minted in the revocation's own second is
 * refused too), and records the grant's last use at most once a minute. The
 * activity write is best-effort: it never fails authentication.
 */
export async function checkMcpGrantAndTouch(params: {
  userId: string;
  clientId: string;
  binding: McpResourceBinding & { resource: string };
  issuedAt: number | undefined;
  ip: string | null;
}): Promise<boolean> {
  const { userId, clientId, binding, issuedAt, ip } = params;
  const [row] = await db
    .select({
      tokensValidAfter: oauthGrantState.tokensValidAfter,
      lastUsedAt: oauthGrantState.lastUsedAt,
    })
    .from(oauthGrantState)
    .where(
      and(
        eq(oauthGrantState.userId, userId),
        eq(oauthGrantState.clientId, clientId),
        eq(oauthGrantState.resource, binding.resource),
      ),
    )
    .limit(1);

  if (row?.tokensValidAfter) {
    if (issuedAt === undefined || issuedAt * 1000 <= row.tokensValidAfter.getTime()) return false;
  }

  const now = new Date();
  if (row?.lastUsedAt && now.getTime() - row.lastUsedAt.getTime() < LAST_USED_TOUCH_INTERVAL_MS) {
    return true;
  }
  try {
    await db
      .insert(oauthGrantState)
      .values({
        userId,
        clientId,
        resource: binding.resource,
        orgId: binding.orgId,
        spaceId: binding.spaceId ?? null,
        lastUsedAt: now,
        lastUsedIp: ip,
      })
      .onConflictDoUpdate({
        target: [oauthGrantState.userId, oauthGrantState.clientId, oauthGrantState.resource],
        // The MCP server's in-process dispatch carries no client IP: keep the
        // one the client's own request recorded.
        set: {
          lastUsedAt: now,
          lastUsedIp: sql`coalesce(excluded.last_used_ip, ${oauthGrantState.lastUsedIp})`,
        },
      });
  } catch (err) {
    logger.warn("oidc: mcp grant activity write failed — auth still allowed", {
      module: "oidc",
      clientId,
      error: getErrorMessage(err),
    });
  }
  return true;
}

// ─── Listing ─────────────────────────────────────────────────────────────────

/**
 * How the platform knows the client, which decides how far its declared name
 * can be trusted: a CIMD metadata document it fetched (the document's host is
 * verified), an RFC 7591 registration (only a non-loopback redirect host is
 * beyond the registrant's say), or an operator.
 */
export type ClientRegistration = "metadata_document" | "dynamic" | "managed";

export interface McpGrant {
  /** Opaque, stable id: a digest of (user, client, resource). */
  id: string;
  userId: string;
  clientId: string;
  resource: string;
  orgId: string;
  orgName: string;
  spaceId: string | null;
  spaceName: string | null;
  clientName: string | null;
  clientOrigin: string | null;
  clientRegistration: ClientRegistration;
  /** Live authorizations (refresh-token chains) the grant holds. */
  sessionCount: number;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  createdAt: Date;
}

/**
 * Whose grants: one user's, or those of `userIds` (an org's current members)
 * on the org's own endpoint and on the spaces in `spaceIds`.
 */
type GrantScope = { userId: string } | { orgId: string; userIds: string[]; spaceIds: Set<string> };

const GRANT_ID_PREFIX = "mcg_";

function mcpGrantId(userId: string, clientId: string, resource: string): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${userId}\u0000${clientId}\u0000${resource}`)
    .digest("hex");
  return `${GRANT_ID_PREFIX}${digest.slice(0, 32)}`;
}

export function isMcpGrantId(id: string): boolean {
  return id.startsWith(GRANT_ID_PREFIX);
}

interface Candidate {
  userId: string;
  clientId: string;
  resource: string;
  binding: McpResourceBinding;
  authorizations: Set<string>;
  createdAt: Date;
}

/**
 * A grant is listed while it holds a live refresh token, or while an access
 * token minted without one (no `offline_access`) may still be in use: its last
 * use is within an access token's lifetime and after its watermark. A grant
 * whose org or space no longer exists is not listed.
 */
async function listMcpGrants(scope: GrantScope): Promise<McpGrant[]> {
  if ("userIds" in scope && scope.userIds.length === 0) return [];
  const now = new Date();
  const inScope = (binding: McpResourceBinding) =>
    !("orgId" in scope) ||
    (binding.orgId === scope.orgId &&
      (binding.spaceId === undefined || scope.spaceIds.has(binding.spaceId)));

  const candidates = new Map<string, Candidate>();
  const add = (userId: string, clientId: string, resource: string, startedAt: Date) => {
    const binding = parseMcpResourceUri(resource);
    if (!binding || !inScope(binding)) return undefined;
    const id = mcpGrantId(userId, clientId, resource);
    const candidate = candidates.get(id) ?? {
      userId,
      clientId,
      resource,
      binding,
      authorizations: new Set<string>(),
      createdAt: startedAt,
    };
    if (startedAt < candidate.createdAt) candidate.createdAt = startedAt;
    candidates.set(id, candidate);
    return candidate;
  };

  const tokenRows = await db
    .select({
      id: oauthRefreshToken.id,
      userId: oauthRefreshToken.userId,
      clientId: oauthRefreshToken.clientId,
      resources: oauthRefreshToken.resources,
      authorizationCodeId: oauthRefreshToken.authorizationCodeId,
      createdAt: oauthRefreshToken.createdAt,
      authTime: oauthRefreshToken.authTime,
    })
    .from(oauthRefreshToken)
    .where(
      and(
        "userId" in scope
          ? eq(oauthRefreshToken.userId, scope.userId)
          : inArray(oauthRefreshToken.userId, scope.userIds),
        isNull(oauthRefreshToken.revoked),
        or(isNull(oauthRefreshToken.expiresAt), gt(oauthRefreshToken.expiresAt, now)),
      ),
    );
  for (const row of tokenRows) {
    for (const resource of row.resources ?? []) {
      const startedAt = row.authTime ?? row.createdAt ?? now;
      add(row.userId, row.clientId, resource, startedAt)?.authorizations.add(
        row.authorizationCodeId ?? row.id,
      );
    }
  }

  const stateRows = await db
    .select()
    .from(oauthGrantState)
    .where(
      "userId" in scope
        ? eq(oauthGrantState.userId, scope.userId)
        : and(
            eq(oauthGrantState.orgId, scope.orgId),
            inArray(oauthGrantState.userId, scope.userIds),
          ),
    );
  const states = new Map(stateRows.map((s) => [mcpGrantId(s.userId, s.clientId, s.resource), s]));
  const accessTokenCutoff = now.getTime() - ACCESS_TOKEN_TTL_SECONDS * 1000;
  for (const [id, state] of states) {
    if (candidates.has(id) || !state.lastUsedAt) continue;
    if (state.lastUsedAt.getTime() < accessTokenCutoff) continue;
    if (state.tokensValidAfter && state.tokensValidAfter >= state.lastUsedAt) continue;
    add(state.userId, state.clientId, state.resource, state.createdAt);
  }
  if (candidates.size === 0) return [];

  const all = [...candidates.values()];
  const clientIds = [...new Set(all.map((c) => c.clientId))];
  const orgIds = [...new Set(all.map((c) => c.binding.orgId))];
  const spaceIds = [...new Set(all.flatMap((c) => c.binding.spaceId ?? []))];
  const [clients, orgRows, spaceRows] = await Promise.all([
    db
      .select({
        clientId: oauthClient.clientId,
        name: oauthClient.name,
        uri: oauthClient.uri,
        redirectUris: oauthClient.redirectUris,
        selfService: oauthClient.selfService,
        clientDiscoveryId: oauthClient.clientDiscoveryId,
      })
      .from(oauthClient)
      .where(inArray(oauthClient.clientId, clientIds)),
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(inArray(organizations.id, orgIds)),
    spaceIds.length
      ? db
          .select({ id: spaces.id, name: spaces.name })
          .from(spaces)
          .where(inArray(spaces.id, spaceIds))
      : [],
  ]);
  const clientById = new Map(clients.map((c) => [c.clientId, c]));
  const orgNames = new Map(orgRows.map((o) => [o.id, o.name]));
  const spaceNames = new Map(spaceRows.map((s) => [s.id, s.name]));

  const grants: McpGrant[] = [];
  for (const [id, c] of candidates) {
    const orgName = orgNames.get(c.binding.orgId);
    const spaceName = c.binding.spaceId ? spaceNames.get(c.binding.spaceId) : null;
    if (orgName === undefined || spaceName === undefined) continue;
    const client = clientById.get(c.clientId);
    const state = states.get(id);
    grants.push({
      id,
      userId: c.userId,
      clientId: c.clientId,
      resource: c.resource,
      orgId: c.binding.orgId,
      orgName,
      spaceId: c.binding.spaceId ?? null,
      spaceName,
      clientName: client?.name ?? null,
      ...describeClient(client, c.clientId),
      sessionCount: c.authorizations.size,
      lastUsedAt: state?.lastUsedAt ?? null,
      lastUsedIp: state?.lastUsedIp ?? null,
      createdAt: c.createdAt,
    });
  }
  return grants;
}

export function listMcpGrantsForUser(userId: string): Promise<McpGrant[]> {
  return listMcpGrants({ userId });
}

export function listMcpGrantsForOrg(scope: {
  orgId: string;
  userIds: string[];
  spaceIds: Set<string>;
}): Promise<McpGrant[]> {
  return listMcpGrants(scope);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function describeClient(
  client:
    | {
        uri: string | null;
        redirectUris: string[];
        selfService: boolean;
        clientDiscoveryId: string | null;
      }
    | undefined,
  clientId: string,
): { clientOrigin: string | null; clientRegistration: ClientRegistration } {
  if (client?.clientDiscoveryId) {
    return { clientOrigin: hostOf(clientId), clientRegistration: "metadata_document" };
  }
  if (!client || client.selfService) {
    const origin = (client?.redirectUris ?? [])
      .map(hostOf)
      .find((host) => host !== null && !LOOPBACK_HOSTS.has(host.replace(/:\d+$/, "")));
    return { clientOrigin: origin ?? null, clientRegistration: "dynamic" };
  }
  return { clientOrigin: client.uri ? hostOf(client.uri) : null, clientRegistration: "managed" };
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

// ─── Revocation ──────────────────────────────────────────────────────────────

/**
 * End a grant: delete its tokens and the user's consent to the client for its
 * resource (reconnecting shows the consent screen again), and raise its
 * watermark so an access token already issued is refused on its next request.
 *
 * The refresh tokens are deleted, not marked revoked: Better Auth treats a
 * revoked refresh token presented again as a stolen one and invalidates every
 * refresh token of the (client, user) pair, which would end the client's other
 * grants too. Their access-token rows go with them (`refresh_id` cascade).
 */
export async function revokeMcpGrant(grant: McpGrant): Promise<void> {
  const { userId, clientId, resource } = grant;
  const ofGrant = <
    T extends typeof oauthRefreshToken | typeof oauthAccessToken | typeof oauthConsent,
  >(
    table: T,
  ) =>
    and(
      eq(table.userId, userId),
      eq(table.clientId, clientId),
      arrayContains(table.resources, [resource]),
    );
  await db.transaction(async (tx) => {
    await tx.delete(oauthRefreshToken).where(ofGrant(oauthRefreshToken));
    await tx.delete(oauthAccessToken).where(ofGrant(oauthAccessToken));
    await tx.delete(oauthConsent).where(ofGrant(oauthConsent));
    const now = new Date();
    await tx
      .insert(oauthGrantState)
      .values({
        userId,
        clientId,
        resource,
        orgId: grant.orgId,
        spaceId: grant.spaceId,
        tokensValidAfter: now,
      })
      .onConflictDoUpdate({
        target: [oauthGrantState.userId, oauthGrantState.clientId, oauthGrantState.resource],
        set: { tokensValidAfter: now },
      });
  });
}
