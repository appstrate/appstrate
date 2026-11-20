// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugin — `/api/auth/access-grants*`: the caller's own access
 * grants (CLI sessions and MCP client grants, `services/access-grants.ts`).
 *
 *   GET  /api/auth/access-grants             list them
 *   POST /api/auth/access-grants/revoke      end one: body `{ id }`
 *   POST /api/auth/access-grants/revoke-all  end every one
 *
 * Browser session only, by construction: these are Better Auth endpoints, so
 * the platform auth pipeline (API keys, OAuth bearers, the MCP endpoint's
 * in-process dispatch) never reaches them, and `getSessionFromCtx` resolves a
 * cookie session or nothing.
 */

import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { APIError } from "better-auth/api";
import * as z from "zod";
import { listResponse } from "@appstrate/core/list-query";
import { getClientIpFromRequest } from "../../../lib/client-ip.ts";
import { logger } from "../../../lib/logger.ts";
import { recordAudit } from "../../../services/audit.ts";
import {
  listAccessGrantsForUser,
  revokeAccessGrantForUser,
  revokeAllAccessGrantsForUser,
} from "../services/access-grants.ts";
import type { McpGrant } from "../services/mcp-grants.ts";

type SessionCtx = Parameters<typeof getSessionFromCtx>[0];

async function requireSessionUserId(ctx: unknown): Promise<string> {
  const session = await getSessionFromCtx(ctx as SessionCtx);
  if (!session?.user?.id) {
    throw new APIError("UNAUTHORIZED", {
      error: "unauthorized",
      error_description: "Authentication required.",
    });
  }
  return session.user.id;
}

/** An MCP grant is bound to an org, so its revocation lands in that org's audit log. */
async function auditMcpRevocations(
  grants: McpGrant[],
  actorId: string,
  request: Request | undefined,
): Promise<void> {
  await recordAudit(
    grants.map((grant) => ({
      orgId: grant.orgId,
      spaceId: grant.spaceId,
      actorType: "user",
      actorId,
      action: "oauth_grant.revoked",
      resourceType: "oauth_grant",
      resourceId: grant.id,
      after: { clientId: grant.clientId, clientName: grant.clientName, userId: grant.userId },
      ip: request ? getClientIpFromRequest(request) : null,
      userAgent: request?.headers.get("user-agent") ?? null,
    })),
  );
}

export function accessGrantsPlugin() {
  return {
    id: "appstrate-access-grants",
    endpoints: {
      listAccessGrants: createAuthEndpoint(
        "/access-grants",
        {
          method: "GET",
        },
        async (ctx) => {
          const userId = await requireSessionUserId(ctx);
          return ctx.json(listResponse(await listAccessGrantsForUser(userId)));
        },
      ),

      revokeAccessGrant: createAuthEndpoint(
        "/access-grants/revoke",
        {
          method: "POST",
          body: z.object({ id: z.string().min(1) }).strict(),
        },
        async (ctx) => {
          const userId = await requireSessionUserId(ctx);
          const outcome = await revokeAccessGrantForUser({ userId, grantId: ctx.body.id });
          if (outcome.revoked && outcome.kind === "mcp") {
            await auditMcpRevocations([outcome.grant], userId, ctx.request);
          }
          if (outcome.revoked) {
            logger.info("oidc: user revoked an access grant", {
              module: "oidc",
              audit: true,
              event: `${outcome.kind}.grant.user_revoked`,
              userId,
              grantId: ctx.body.id,
            });
          }
          return ctx.json({ revoked: outcome.revoked });
        },
      ),

      revokeAllAccessGrants: createAuthEndpoint(
        "/access-grants/revoke-all",
        {
          method: "POST",
        },
        async (ctx) => {
          const userId = await requireSessionUserId(ctx);
          const { revokedCount, mcpGrants } = await revokeAllAccessGrantsForUser(userId);
          await auditMcpRevocations(mcpGrants, userId, ctx.request);
          logger.info("oidc: user revoked every access grant", {
            module: "oidc",
            audit: true,
            event: "access_grants.user_revoked_all",
            userId,
            revokedCount,
          });
          return ctx.json({ revoked_count: revokedCount });
        },
      ),
    },
  };
}
