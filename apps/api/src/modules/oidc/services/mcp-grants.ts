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
import { oauthGrantState } from "@appstrate/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { parseMcpResourceUri } from "../../../lib/audiences.ts";
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
