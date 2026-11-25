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
 *
 * It also hooks `/oauth2/token`, where an MCP grant's tokens are issued: each
 * issuance is recorded, and one whose authorization a revocation has ended
 * since is refused (`admitMcpTokenIssuance`). And `/oauth2/revoke`, where the
 * refresh token a client revoked is deleted and an invalid token is answered
 * 200 (`settleRevocation`).
 */

import { createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { stripAccessTokenAuthorizationScheme } from "better-auth/oauth2";
import { APIError, isAPIError } from "better-auth/api";
import * as z from "zod";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { oauthRefreshToken } from "@appstrate/db/schema";
import { listResponse } from "@appstrate/core/list-query";
import { getClientIpFromRequest } from "../../../lib/client-ip.ts";
import { logger } from "../../../lib/logger.ts";
import { recordAudit } from "../../../services/audit.ts";
import {
  listAccessGrantsForUser,
  mcpRevocationAudit,
  revokeAccessGrantForUser,
  revokeAllAccessGrantsForUser,
} from "../services/access-grants.ts";
import {
  admitMcpTokenIssuance,
  authorizationCodeIssuedAt,
  findMcpRefreshTokenOwner,
  hashOAuthToken,
} from "../services/mcp-grants.ts";
import { verifyEndUserAccessToken } from "../services/enduser-token.ts";
import { mcpBindingFromAudiences } from "../../../lib/audiences.ts";

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

function grantAuditContext(request: Request | undefined) {
  return {
    ip: request ? getClientIpFromRequest(request) : null,
    userAgent: request?.headers.get("user-agent") ?? null,
  };
}

/**
 * When the authority a `/oauth2/token` request presents was established: its
 * code's issuance for `authorization_code`, the request's own start for
 * `refresh_token` (the refresh token is read after it). Absent for any other
 * grant, or a code with no row (the provider refuses that request itself).
 * Keyed by the request, the one object both hooks of a call share.
 */
const authorizedAtByRequest = new WeakMap<Request, Date>();

type TokenHookCtx = { request?: Request; body?: unknown; context: unknown };

const isTokenEndpoint = (ctx: { path?: string }) => ctx.path === "/oauth2/token";

async function captureAuthorizedAt(ctx: TokenHookCtx): Promise<void> {
  if (!ctx.request) return;
  const body = (ctx.body ?? {}) as { grant_type?: unknown; code?: unknown };
  if (body.grant_type === "refresh_token") {
    authorizedAtByRequest.set(ctx.request, new Date());
  } else if (body.grant_type === "authorization_code" && typeof body.code === "string") {
    const issuedAt = await authorizationCodeIssuedAt(body.code);
    if (issuedAt) authorizedAtByRequest.set(ctx.request, issuedAt);
  }
}

async function admitIssuedTokens(ctx: TokenHookCtx): Promise<void> {
  const returned = (ctx.context as { returned?: unknown }).returned as
    { access_token?: unknown; refresh_token?: unknown } | undefined;
  if (typeof returned?.access_token !== "string") return;
  const claims = await verifyEndUserAccessToken(returned.access_token);
  const binding = claims ? mcpBindingFromAudiences(claims.audiences) : undefined;
  const refreshToken =
    typeof returned.refresh_token === "string" ? returned.refresh_token : undefined;
  const owner =
    binding && claims?.clientId
      ? { userId: claims.authUserId, clientId: claims.clientId }
      : refreshToken
        ? await findMcpRefreshTokenOwner(refreshToken)
        : undefined;
  if (!owner) return;
  // An issuance with no instant to judge it by is refused, never let through.
  const authorizedAt = ctx.request ? authorizedAtByRequest.get(ctx.request) : undefined;
  const admitted =
    authorizedAt !== undefined &&
    (await admitMcpTokenIssuance({
      ...owner,
      binding,
      authorizedAt,
      refreshToken,
    }));
  if (!admitted) {
    logger.info("oidc: token issuance refused — the MCP grant was revoked since", {
      module: "oidc",
      ...owner,
    });
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: "This authorization was revoked.",
    });
  }
}

const isRevokeEndpoint = (ctx: { path?: string }) => ctx.path === "/oauth2/revoke";

// RFC 7009 allows ignoring the hint. The pinned provider otherwise searches only the hinted type.
async function searchAllTokenTypes(ctx: TokenHookCtx) {
  const body = ctx.body as { token_type_hint?: string } | undefined;
  if (body?.token_type_hint) return { context: { body: { ...body, token_type_hint: "" } } };
}

/**
 * Settle a `/oauth2/revoke` call after Better Auth answered it.
 *
 * On success, delete the refresh token it revoked: Better Auth only marks it, and
 * a marked token presented again reads as stolen, tearing down the (client, user)
 * family. Upstream's still: a concurrent refresh between that mark and this delete.
 *
 * On an invalid token (unknown, expired, already revoked), answer 200 as RFC 7009
 * §2.2 requires. Better Auth means to (`error.name === "BAD_REQUEST"`), but its
 * `APIError.name` is "APIError", so that 400 leaks. A missing token is a 400
 * thrown before any lookup and stays one; so do 401 and `unsupported_token_type`.
 */
async function settleRevocation(ctx: TokenHookCtx): Promise<Response | void> {
  const raw = (ctx.body as { token?: unknown } | undefined)?.token;
  // Stripped as the revoke endpoint strips it, so both judge the same token.
  const token = typeof raw === "string" ? stripAccessTokenAuthorizationScheme(raw) : "";
  if (token.length === 0) return;
  const returned = (ctx.context as { returned?: unknown }).returned;
  if (returned instanceof Error) {
    // With no hint, this is the provider's final lookup miss after authenticating the client.
    // Its request parser also uses invalid_request for malformed client authentication.
    if (
      isAPIError(returned) &&
      returned.statusCode === 400 &&
      returned.body?.error === "invalid_request" &&
      returned.body?.error_description === "token not found"
    ) {
      // A `Response` is the one value whose status survives the dispatch
      // (`toResponse` passes it through); this is the success answer's shape.
      return new Response(null, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return;
  }
  try {
    await db
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.token, hashOAuthToken(token)),
          isNotNull(oauthRefreshToken.revoked),
        ),
      );
  } catch (err) {
    // The revoke succeeded; a failed cleanup must not make it a 500.
    logger.error("deleting a revoked refresh token failed", {
      module: "oidc",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function accessGrantsPlugin() {
  return {
    id: "appstrate-access-grants",
    hooks: {
      before: [
        { matcher: isTokenEndpoint, handler: createAuthMiddleware(captureAuthorizedAt) },
        { matcher: isRevokeEndpoint, handler: createAuthMiddleware(searchAllTokenTypes) },
      ],
      after: [
        { matcher: isTokenEndpoint, handler: createAuthMiddleware(admitIssuedTokens) },
        { matcher: isRevokeEndpoint, handler: createAuthMiddleware(settleRevocation) },
      ],
    },
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
            await recordAudit(
              mcpRevocationAudit(outcome.grant, userId, grantAuditContext(ctx.request)),
            );
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
          const revokedCount = await revokeAllAccessGrantsForUser(
            userId,
            grantAuditContext(ctx.request),
          );
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
