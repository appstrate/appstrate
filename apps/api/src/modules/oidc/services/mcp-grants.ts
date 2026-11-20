// SPDX-License-Identifier: Apache-2.0

/**
 * MCP access grants — one per (user, OAuth client, MCP resource).
 *
 * An MCP client (Claude Code, claude.ai, Cursor, …) authorizes against the
 * platform's OAuth server and receives tokens audience-bound to exactly one MCP
 * resource: an org endpoint (`/api/mcp/o/:org`) or a space endpoint
 * (`/api/mcp/o/:org/s/:space`). The tokens live in Better Auth's
 * `oauth_refresh_tokens` / `oauth_access_tokens`; what those tables cannot hold
 * lives in `oauth_grant_states` (see `packages/db/src/schema/oidc.ts`).
 *
 * The grant, not the token, is the unit a person reasons about: a refresh
 * rotates rows, and one client may hold several live refresh tokens for the
 * same resource (one per authorization, e.g. two machines sharing a CIMD
 * client). Listing groups them; revoking ends all of them.
 */

import { getErrorMessage } from "@appstrate/core/errors";
import { db } from "@appstrate/db/client";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthGrantState,
  oauthRefreshToken,
  spaces,
} from "@appstrate/db/schema";
import { and, arrayContains, arrayOverlaps, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  getMcpOrgResourceUri,
  getMcpSpaceResourceUri,
  parseMcpResourceUri,
} from "../../../lib/audiences.ts";
import { logger } from "../../../lib/logger.ts";

/** At most one activity write per grant per interval, as for CLI sessions. */
const LAST_USED_TOUCH_INTERVAL_MS = 60 * 1000;

/** A user agent is display data: bound what one request can make us store. */
const USER_AGENT_MAX_LENGTH = 512;

/**
 * Hot-path check called by the OIDC strategy for every JWT bound to an MCP
 * resource. Refuses a token issued at or before the grant's revocation
 * watermark, and records the grant's activity at most once a minute.
 *
 * `issuedAt` is the JWT `iat` in seconds. A token issued in the same second as
 * the revocation is refused too: a client reconnecting that fast simply
 * re-authorizes.
 *
 * The activity write is best-effort: it creates the grant's row on first use,
 * and a failure (the space was deleted a moment ago, a transient error) never
 * fails authentication.
 */
export async function checkMcpGrantAndTouch(params: {
  userId: string;
  clientId: string;
  resource: string;
  issuedAt: number | undefined;
  ip: string | null;
  userAgent: string | null;
}): Promise<boolean> {
  const { userId, clientId, resource, issuedAt, ip, userAgent } = params;
  const binding = parseMcpResourceUri(resource);
  if (!binding) return true;

  const [row] = await db
    .select({
      tokensValidAfter: oauthGrantState.tokensValidAfter,
      lastUsedAt: oauthGrantState.lastUsedAt,
    })
    .from(oauthGrantState)
    .where(grantKey(userId, clientId, resource))
    .limit(1);

  if (row?.tokensValidAfter) {
    // A token without `iat` cannot prove it postdates the revocation.
    if (issuedAt === undefined) return false;
    if (issuedAt * 1000 <= row.tokensValidAfter.getTime()) return false;
  }

  const now = Date.now();
  const stale = !row?.lastUsedAt || now - row.lastUsedAt.getTime() >= LAST_USED_TOUCH_INTERVAL_MS;
  if (stale) {
    const activity = {
      lastUsedAt: new Date(now),
      lastUsedIp: ip,
      lastUsedUserAgent: userAgent?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
    };
    try {
      await db
        .insert(oauthGrantState)
        .values({
          userId,
          clientId,
          resource,
          orgId: binding.orgId,
          spaceId: binding.spaceId ?? null,
          ...activity,
        })
        .onConflictDoUpdate({
          target: [oauthGrantState.userId, oauthGrantState.clientId, oauthGrantState.resource],
          // An in-process re-dispatch (the MCP server invoking a REST route)
          // carries neither the caller's IP nor its user agent: keep the
          // ones a real request recorded.
          set: {
            lastUsedAt: activity.lastUsedAt,
            lastUsedIp: sql`coalesce(excluded.last_used_ip, ${oauthGrantState.lastUsedIp})`,
            lastUsedUserAgent: sql`coalesce(excluded.last_used_user_agent, ${oauthGrantState.lastUsedUserAgent})`,
          },
        });
    } catch (err) {
      logger.warn("oidc: mcp grant activity write failed — auth still allowed", {
        module: "oidc",
        clientId,
        error: getErrorMessage(err),
      });
    }
  }
  return true;
}

function grantKey(userId: string, clientId: string, resource: string) {
  return and(
    eq(oauthGrantState.userId, userId),
    eq(oauthGrantState.clientId, clientId),
    eq(oauthGrantState.resource, resource),
  );
}

// ─── Listing ─────────────────────────────────────────────────────────────────

/**
 * How the platform knows the client, which decides how far its displayed name
 * can be trusted:
 * - `metadata_document` — CIMD: the `client_id` is an HTTPS URL whose document
 *   the server fetched; its host is the client's verified origin.
 * - `dynamic` — RFC 7591 registration: every field is the registrant's own
 *   claim. A non-loopback redirect host is the only origin it cannot fake
 *   (the code is delivered there).
 * - `managed` — registered by an operator.
 */
export type ClientRegistration = "metadata_document" | "dynamic" | "managed";

export interface McpGrant {
  /** Opaque, stable id: a digest of (user, client, resource). */
  id: string;
  userId: string;
  clientId: string;
  resource: string;
  orgId: string;
  spaceId: string | null;
  clientName: string | null;
  clientIcon: string | null;
  clientOrigin: string | null;
  clientRegistration: ClientRegistration;
  /** Live authorizations (refresh-token chains) the grant holds. */
  sessionCount: number;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  lastUsedUserAgent: string | null;
  createdAt: Date;
  /** When the last refresh token expires; `null` when none expires or there is none. */
  expiresAt: Date | null;
}

/** An MCP access token lives 10 minutes (`auth/plugins.ts`). */
const ACCESS_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

const GRANT_ID_PREFIX = "mcg_";

/** The grant's public id. Not a secret: it only names a grant its reader can already see. */
export function mcpGrantId(userId: string, clientId: string, resource: string): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${userId}\u0000${clientId}\u0000${resource}`)
    .digest("hex");
  return `${GRANT_ID_PREFIX}${digest.slice(0, 32)}`;
}

export function isMcpGrantId(id: string): boolean {
  return id.startsWith(GRANT_ID_PREFIX);
}

interface GrantAccumulator {
  userId: string;
  clientId: string;
  resource: string;
  authorizations: Set<string>;
  createdAt: Date;
  expiresAt: Date | null;
  neverExpires: boolean;
}

/**
 * The grants held by one user, or by every user on one org's MCP resources.
 *
 * A grant is listed while it holds a live refresh token, or while an access
 * token minted without one (no `offline_access`) may still be in use: its last
 * use is within an access token's lifetime and postdates its watermark.
 */
async function listMcpGrants(filter: { userId: string } | { orgId: string }): Promise<McpGrant[]> {
  const now = new Date();
  const tokenRows = await db
    .select({
      userId: oauthRefreshToken.userId,
      clientId: oauthRefreshToken.clientId,
      resources: oauthRefreshToken.resources,
      authorizationCodeId: oauthRefreshToken.authorizationCodeId,
      id: oauthRefreshToken.id,
      createdAt: oauthRefreshToken.createdAt,
      authTime: oauthRefreshToken.authTime,
      expiresAt: oauthRefreshToken.expiresAt,
    })
    .from(oauthRefreshToken)
    .where(
      and(
        isNull(oauthRefreshToken.revoked),
        or(isNull(oauthRefreshToken.expiresAt), gt(oauthRefreshToken.expiresAt, now)),
        "userId" in filter
          ? eq(oauthRefreshToken.userId, filter.userId)
          : arrayOverlaps(oauthRefreshToken.resources, await orgMcpResources(filter.orgId)),
      ),
    );

  const grants = new Map<string, GrantAccumulator>();
  for (const row of tokenRows) {
    for (const resource of row.resources ?? []) {
      const binding = parseMcpResourceUri(resource);
      if (!binding) continue;
      if ("orgId" in filter && binding.orgId !== filter.orgId) continue;
      const key = mcpGrantId(row.userId, row.clientId, resource);
      const startedAt = row.authTime ?? row.createdAt ?? now;
      const acc = grants.get(key) ?? {
        userId: row.userId,
        clientId: row.clientId,
        resource,
        authorizations: new Set<string>(),
        createdAt: startedAt,
        expiresAt: null,
        neverExpires: false,
      };
      acc.authorizations.add(row.authorizationCodeId ?? row.id);
      if (startedAt < acc.createdAt) acc.createdAt = startedAt;
      if (row.expiresAt === null) acc.neverExpires = true;
      else if (!acc.expiresAt || row.expiresAt > acc.expiresAt) acc.expiresAt = row.expiresAt;
      grants.set(key, acc);
    }
  }

  const stateRows = await db
    .select()
    .from(oauthGrantState)
    .where(
      "userId" in filter
        ? eq(oauthGrantState.userId, filter.userId)
        : eq(oauthGrantState.orgId, filter.orgId),
    );
  const states = new Map(stateRows.map((s) => [mcpGrantId(s.userId, s.clientId, s.resource), s]));
  const recent = new Date(now.getTime() - ACCESS_TOKEN_LIFETIME_MS);
  for (const [key, state] of states) {
    if (grants.has(key)) continue;
    if (!state.lastUsedAt || state.lastUsedAt < recent) continue;
    if (state.tokensValidAfter && state.tokensValidAfter >= state.lastUsedAt) continue;
    grants.set(key, {
      userId: state.userId,
      clientId: state.clientId,
      resource: state.resource,
      authorizations: new Set(),
      createdAt: state.createdAt,
      expiresAt: null,
      neverExpires: false,
    });
  }
  if (grants.size === 0) return [];

  const clientIds = [...new Set([...grants.values()].map((g) => g.clientId))];
  const clients = await db
    .select({
      clientId: oauthClient.clientId,
      name: oauthClient.name,
      icon: oauthClient.icon,
      uri: oauthClient.uri,
      redirectUris: oauthClient.redirectUris,
      selfService: oauthClient.selfService,
      clientDiscoveryId: oauthClient.clientDiscoveryId,
    })
    .from(oauthClient)
    .where(inArray(oauthClient.clientId, clientIds));
  const clientById = new Map(clients.map((c) => [c.clientId, c]));

  const result: McpGrant[] = [];
  for (const [id, g] of grants) {
    const binding = parseMcpResourceUri(g.resource)!;
    const client = clientById.get(g.clientId);
    const state = states.get(id);
    const identity = describeClient(client, g.clientId);
    result.push({
      id,
      userId: g.userId,
      clientId: g.clientId,
      resource: g.resource,
      orgId: binding.orgId,
      spaceId: binding.spaceId ?? null,
      clientName: client?.name ?? null,
      clientIcon: client?.icon ?? null,
      ...identity,
      sessionCount: g.authorizations.size,
      lastUsedAt: state?.lastUsedAt ?? null,
      lastUsedIp: state?.lastUsedIp ?? null,
      lastUsedUserAgent: state?.lastUsedUserAgent ?? null,
      createdAt: g.createdAt,
      expiresAt: g.neverExpires ? null : g.expiresAt,
    });
  }
  return result;
}

export function listMcpGrantsForUser(userId: string): Promise<McpGrant[]> {
  return listMcpGrants({ userId });
}

export function listMcpGrantsForOrg(orgId: string): Promise<McpGrant[]> {
  return listMcpGrants({ orgId });
}

/** The org's MCP resource URIs: its own and one per space. */
async function orgMcpResources(orgId: string): Promise<string[]> {
  const rows = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.orgId, orgId));
  return [getMcpOrgResourceUri(orgId), ...rows.map((s) => getMcpSpaceResourceUri(orgId, s.id))];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function describeClient(
  client:
    | {
        clientId: string;
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
    const redirectHosts = (client?.redirectUris ?? [])
      .map(hostOf)
      .filter((h): h is string => h !== null && !LOOPBACK_HOSTS.has(h));
    return { clientOrigin: redirectHosts[0] ?? null, clientRegistration: "dynamic" };
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
 * End a grant: revoke every token it holds, take its resource out of the
 * user's consent to the client (the next authorization shows the consent
 * screen again), and raise its watermark so an access token already issued is
 * refused on its next request.
 */
export async function revokeMcpGrant(grant: {
  userId: string;
  clientId: string;
  resource: string;
}): Promise<void> {
  const { userId, clientId, resource } = grant;
  const binding = parseMcpResourceUri(resource);
  if (!binding) return;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(oauthRefreshToken)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthRefreshToken.userId, userId),
          eq(oauthRefreshToken.clientId, clientId),
          isNull(oauthRefreshToken.revoked),
          arrayContains(oauthRefreshToken.resources, [resource]),
        ),
      );
    await tx
      .update(oauthAccessToken)
      .set({ revoked: now })
      .where(
        and(
          eq(oauthAccessToken.userId, userId),
          eq(oauthAccessToken.clientId, clientId),
          isNull(oauthAccessToken.revoked),
          arrayContains(oauthAccessToken.resources, [resource]),
        ),
      );
    const consentKey = and(
      eq(oauthConsent.userId, userId),
      eq(oauthConsent.clientId, clientId),
      arrayContains(oauthConsent.resources, [resource]),
    );
    await tx
      .update(oauthConsent)
      .set({ resources: sql`array_remove(${oauthConsent.resources}, ${resource})`, updatedAt: now })
      .where(consentKey);
    // A consent left covering no resource would let a resource-less request
    // through without a prompt: it no longer stands for anything the user
    // agreed to keep.
    await tx
      .delete(oauthConsent)
      .where(
        and(
          eq(oauthConsent.userId, userId),
          eq(oauthConsent.clientId, clientId),
          sql`cardinality(${oauthConsent.resources}) = 0`,
        ),
      );
    await tx
      .insert(oauthGrantState)
      .values({
        userId,
        clientId,
        resource,
        orgId: binding.orgId,
        spaceId: binding.spaceId ?? null,
        tokensValidAfter: now,
      })
      .onConflictDoUpdate({
        target: [oauthGrantState.userId, oauthGrantState.clientId, oauthGrantState.resource],
        set: { tokensValidAfter: now },
      });
  });
}
