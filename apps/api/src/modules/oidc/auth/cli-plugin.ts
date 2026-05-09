// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugin — `/api/auth/cli/*` endpoints (issue #165, #251).
 *
 * Exposes the rotating-refresh-token surface used by the 2.x CLI.
 * Mounted alongside the existing `deviceAuthorization()` plugin — the
 * CLI polls `/cli/token` which returns a JWT + rotating refresh-token
 * pair.
 *
 * Endpoints:
 *
 *   POST /api/auth/cli/token
 *     grant_type=urn:ietf:params:oauth:grant-type:device_code
 *       body: { grant_type, device_code, client_id }
 *       200: { access_token, refresh_token, token_type, expires_in,
 *              refresh_expires_in, scope }
 *       400: { error, error_description } with RFC 6749 / RFC 8628 codes
 *     grant_type=refresh_token
 *       body: { grant_type, refresh_token, client_id }
 *       200: same shape — access & refresh both rotated.
 *       400: invalid_grant on reuse detection (family already revoked).
 *
 *   POST /api/auth/cli/revoke
 *     body: { token, client_id }   // `token` = refresh_token
 *     200: { revoked: boolean }
 *
 *   GET  /api/auth/cli/sessions                    [issue #251]
 *     Cookie auth required (BA session). Lists the caller's active
 *     CLI sessions (one entry per `family_id` head, not revoked, not
 *     expired). 200: { object: "list", data: [...], hasMore: false }
 *
 *   POST /api/auth/cli/sessions/revoke              [issue #251]
 *     Cookie auth required. Body: { familyId }. Revokes a single
 *     session owned by the caller. 200: { revoked: boolean } —
 *     `false` when the family is unknown / not owned / already revoked.
 *
 *   POST /api/auth/cli/sessions/revoke-all          [issue #251]
 *     Cookie auth required. Server primitive backing
 *     `appstrate logout --all`. 200: { revokedCount: number }.
 *
 * Error vocabulary matches `CliTokenError` — the client renders these
 * directly (`authorization_pending`, `slow_down`, `access_denied`,
 * `expired_token`, `invalid_grant`, `invalid_request`, `invalid_client`,
 * `server_error`). The session-management endpoints return ordinary BA
 * error shapes (`UNAUTHORIZED` when the cookie is missing).
 *
 * Client validation: we re-use the same `validateDeviceFlowClient`
 * allowlist the BA `deviceAuthorization()` plugin uses (grant_types
 * must include `device_code`). For refresh_token grants we additionally
 * check the token's `client_id` column matches.
 *
 * Why cookie-only on the session endpoints: these are dashboard-facing
 * surfaces; the API-key story for managing CLI sessions is intentionally
 * deferred — granting `cli-sessions:delete` to an API key would let a
 * compromised key sign every device of every account out of the platform,
 * which is a much wider blast radius than the key holder's intent.
 * If a future use case justifies the scope, it lands as a Phase 3
 * extension with its own RBAC contribution.
 */

import { eq } from "drizzle-orm";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { APIError } from "better-auth/api";
import * as z from "zod";
import { db } from "@appstrate/db/client";
import { oauthClient } from "../schema.ts";
import {
  CliTokenError,
  exchangeDeviceCodeForTokens,
  listSessionsForUser,
  revokeAllFamiliesForUser,
  revokeFamilyForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  type DeviceMetadata,
} from "../services/cli-tokens.ts";
import { getClientIpFromRequest } from "../../../lib/client-ip.ts";
import { listResponse } from "../../../lib/list-response.ts";

/** Header the CLI uses to declare a human-friendly device label
 *  (mirrors `gh auth login --hostname`). Optional — when absent, the UI
 *  falls back to a UA-derived label. Capped to a sane length to keep the
 *  device list scannable; longer values are truncated. */
const DEVICE_NAME_HEADER = "x-appstrate-device-name";
const DEVICE_NAME_MAX_LENGTH = 120;

/** Reasonable upper bound on `User-Agent` storage. Real-world UAs sit
 *  well under 1 KB; we cap to defang a misbehaving client that ships a
 *  multi-KB blob into a freshly-indexable text column. */
const USER_AGENT_MAX_LENGTH = 1024;

function clamp(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function metadataFromRequest(request: Request | undefined): DeviceMetadata {
  if (!request) return {};
  const headers = request.headers;
  return {
    deviceName: clamp(headers.get(DEVICE_NAME_HEADER), DEVICE_NAME_MAX_LENGTH),
    userAgent: clamp(headers.get("user-agent"), USER_AGENT_MAX_LENGTH),
    ip: getClientIpFromRequest(request),
  };
}

// RFC 6749 §5.2 error → HTTP status. Polling errors (authorization_pending,
// slow_down) are 400 per RFC 8628 §3.5.
function httpStatusFor(code: string): 400 | 401 {
  if (code === "invalid_client") return 401;
  return 400;
}

// RFC 6749 §5.2: token-endpoint error responses MUST include
// `Cache-Control: no-store` and `Pragma: no-cache`. Intermediate proxies
// rarely cache 4xx in practice, but the spec is explicit and the cost
// of two header strings is zero.
const NO_STORE_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

function throwApiError(err: CliTokenError): never {
  const status = httpStatusFor(err.code);
  const upper = status === 401 ? "UNAUTHORIZED" : "BAD_REQUEST";
  throw new APIError(
    upper,
    {
      error: err.code,
      error_description: err.description,
    },
    NO_STORE_HEADERS,
  );
}

// Union schema to accept both grant types in a single endpoint.
// `z.discriminatedUnion` would be cleaner but BA's better-call layer
// strips unknown keys before Zod sees them, so the simpler optional-field
// schema is more robust.
const cliTokenBodySchema = z.object({
  grant_type: z.string().min(1),
  device_code: z.string().optional(),
  refresh_token: z.string().optional(),
  client_id: z.string().min(1),
});

const cliRevokeBodySchema = z.object({
  token: z.string().min(1),
  client_id: z.string().min(1),
});

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REFRESH_TOKEN_GRANT = "refresh_token";

async function validateClientOrThrow(clientId: string): Promise<void> {
  const [row] = await db
    .select({ grantTypes: oauthClient.grantTypes, disabled: oauthClient.disabled })
    .from(oauthClient)
    .where(eq(oauthClient.clientId, clientId))
    .limit(1);
  if (!row || row.disabled === true) {
    throw new APIError(
      "UNAUTHORIZED",
      {
        error: "invalid_client",
        error_description: "Unknown or disabled client.",
      },
      NO_STORE_HEADERS,
    );
  }
  const grants = row.grantTypes ?? [];
  // Accept the call if the client is registered for either the device-code
  // or refresh-token grant — the endpoint-level grant_type check below
  // enforces the actual grant being used.
  if (!grants.includes(DEVICE_CODE_GRANT) && !grants.includes(REFRESH_TOKEN_GRANT)) {
    throw new APIError(
      "UNAUTHORIZED",
      {
        error: "invalid_client",
        error_description: "Client is not registered for CLI grant types.",
      },
      NO_STORE_HEADERS,
    );
  }
}

export function cliTokenPlugin() {
  return {
    id: "appstrate-cli-token",
    endpoints: {
      cliToken: createAuthEndpoint(
        "/cli/token",
        {
          method: "POST",
          body: cliTokenBodySchema,
          metadata: {
            openapi: {
              description:
                "Exchange a device_code (RFC 8628) OR a refresh token for a fresh JWT access token + rotating refresh token pair. Used by the `appstrate` CLI.",
              responses: {
                200: {
                  description: "Token pair issued",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          access_token: { type: "string" },
                          refresh_token: { type: "string" },
                          token_type: { type: "string", enum: ["Bearer"] },
                          expires_in: { type: "integer" },
                          refresh_expires_in: { type: "integer" },
                          scope: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const { grant_type, device_code, refresh_token, client_id } = ctx.body;
          await validateClientOrThrow(client_id);

          try {
            if (grant_type === DEVICE_CODE_GRANT) {
              if (!device_code) {
                throw new CliTokenError(
                  "invalid_request",
                  "device_code is required for device_code grant.",
                );
              }
              const tokens = await exchangeDeviceCodeForTokens({
                deviceCodeValue: device_code,
                clientId: client_id,
                metadata: metadataFromRequest(ctx.request),
              });
              return ctx.json(
                {
                  access_token: tokens.accessToken,
                  refresh_token: tokens.refreshToken,
                  token_type: tokens.tokenType,
                  expires_in: tokens.expiresIn,
                  refresh_expires_in: tokens.refreshExpiresIn,
                  scope: tokens.scope,
                },
                { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
              );
            }
            if (grant_type === REFRESH_TOKEN_GRANT) {
              if (!refresh_token) {
                throw new CliTokenError(
                  "invalid_request",
                  "refresh_token is required for refresh_token grant.",
                );
              }
              const tokens = await rotateRefreshToken({
                refreshToken: refresh_token,
                clientId: client_id,
                // Only the IP is meaningful on rotations — `last_used_at`
                // is set by the service from `Date.now()`. UA/deviceName
                // are head-of-family attributes captured at login time;
                // re-capturing them on every refresh would let a CLI
                // silently mutate its declared identity.
                metadata: { ip: getClientIpFromRequest(ctx.request) },
              });
              return ctx.json(
                {
                  access_token: tokens.accessToken,
                  refresh_token: tokens.refreshToken,
                  token_type: tokens.tokenType,
                  expires_in: tokens.expiresIn,
                  refresh_expires_in: tokens.refreshExpiresIn,
                  scope: tokens.scope,
                },
                { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } },
              );
            }
            throw new CliTokenError("invalid_request", `Unsupported grant_type: ${grant_type}`);
          } catch (err) {
            if (err instanceof CliTokenError) throwApiError(err);
            throw err;
          }
        },
      ),

      cliRevoke: createAuthEndpoint(
        "/cli/revoke",
        {
          method: "POST",
          body: cliRevokeBodySchema,
          metadata: {
            openapi: {
              description:
                "Revoke a CLI refresh token's family. Idempotent. Per RFC 7009 §2.2 the response is uniform (`{ revoked: true }`) even when the token is unknown or client-mismatched — the underlying hit/miss discriminator is kept in the audit log only, so a caller cannot probe token validity through the response shape.",
              responses: {
                200: {
                  description: "Revocation acknowledged",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { revoked: { type: "boolean", const: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const { token, client_id } = ctx.body;
          await validateClientOrThrow(client_id);
          // Service-layer call still returns a discriminator for audit
          // logging — but we DISCARD it here. RFC 7009 §2.2 says the
          // endpoint MUST respond 200 for invalid tokens too, so a
          // `{ revoked: false }` response would be a token-existence
          // oracle on a 256-bit space that an attacker with an
          // unlimited budget could still probe. The hit/miss distinction
          // lives in the audit log (`cli.refresh_token.revoke.*` events).
          await revokeRefreshToken({
            refreshToken: token,
            clientId: client_id,
          });
          return ctx.json({ revoked: true });
        },
      ),

      // ── Issue #251: dashboard-facing session management ────────────────

      cliListSessions: createAuthEndpoint(
        "/cli/sessions",
        {
          method: "GET",
          metadata: {
            openapi: {
              description:
                'List the caller\'s active CLI sessions (one entry per device). Cookie auth required — the listing is scoped to `c.get("user").id` derived from the BA session. `current` is always `false` for cookie callers because the dashboard does not present a refresh token.',
              responses: {
                200: {
                  description: "Session list",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: {
                          object: { type: "string", const: "list" },
                          data: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                familyId: { type: "string" },
                                deviceName: { type: "string", nullable: true },
                                userAgent: { type: "string", nullable: true },
                                createdIp: { type: "string", nullable: true },
                                lastUsedIp: { type: "string", nullable: true },
                                lastUsedAt: {
                                  type: "string",
                                  format: "date-time",
                                  nullable: true,
                                },
                                createdAt: { type: "string", format: "date-time" },
                                expiresAt: { type: "string", format: "date-time" },
                                current: { type: "boolean" },
                              },
                            },
                          },
                          hasMore: { type: "boolean" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0]);
          if (!session?.user?.id) {
            throw new APIError("UNAUTHORIZED", {
              error: "unauthorized",
              error_description: "Authentication required.",
            });
          }
          const sessions = await listSessionsForUser(session.user.id);
          return ctx.json(listResponse(sessions));
        },
      ),

      cliRevokeSession: createAuthEndpoint(
        "/cli/sessions/revoke",
        {
          method: "POST",
          body: z.object({ familyId: z.string().min(1) }),
          metadata: {
            openapi: {
              description:
                "Revoke a single CLI session owned by the caller. Cookie auth required. `revoked: false` is returned when the family does not exist, does not belong to the caller, or has already been revoked — the route layer does not distinguish these cases at the HTTP shape so an attacker who somehow guessed a `family_id` cannot probe ownership through the response.",
              responses: {
                200: {
                  description: "Revocation outcome",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { revoked: { type: "boolean" } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0]);
          if (!session?.user?.id) {
            throw new APIError("UNAUTHORIZED", {
              error: "unauthorized",
              error_description: "Authentication required.",
            });
          }
          const revoked = await revokeFamilyForUser({
            userId: session.user.id,
            familyId: ctx.body.familyId,
          });
          return ctx.json({ revoked });
        },
      ),

      cliRevokeAllSessions: createAuthEndpoint(
        "/cli/sessions/revoke-all",
        {
          method: "POST",
          metadata: {
            openapi: {
              description:
                "Revoke every active CLI session belonging to the caller. Server primitive backing `appstrate logout --all`. Cookie auth required. Idempotent — calling on an account with no active sessions returns `{ revokedCount: 0 }`.",
              responses: {
                200: {
                  description: "Bulk revocation outcome",
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { revokedCount: { type: "integer", minimum: 0 } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        async (ctx) => {
          const session = await getSessionFromCtx(ctx as Parameters<typeof getSessionFromCtx>[0]);
          if (!session?.user?.id) {
            throw new APIError("UNAUTHORIZED", {
              error: "unauthorized",
              error_description: "Authentication required.",
            });
          }
          const result = await revokeAllFamiliesForUser(session.user.id);
          return ctx.json(result);
        },
      ),
    },
  };
}
