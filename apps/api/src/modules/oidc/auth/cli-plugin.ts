// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugin — `/api/auth/cli/*` endpoints (issue #165).
 *
 * Exposes the rotating-refresh-token surface that replaces BA's default
 * session-minting `/device/token`. Mounted alongside the existing
 * `deviceAuthorization()` plugin — the old `/device/token` stays
 * reachable for backward compatibility with legacy CLI binaries, but
 * the 2.x CLI polls `/cli/token` which returns a JWT + rotating
 * refresh-token pair.
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
 * Error vocabulary matches `CliTokenError` — the client renders these
 * directly (`authorization_pending`, `slow_down`, `access_denied`,
 * `expired_token`, `invalid_grant`, `invalid_request`, `invalid_client`,
 * `server_error`).
 *
 * Client validation: we re-use the same `validateDeviceFlowClient`
 * allowlist the BA `deviceAuthorization()` plugin uses (grant_types
 * must include `device_code`). For refresh_token grants we additionally
 * check the token's `client_id` column matches.
 */

import { eq } from "drizzle-orm";
import { createAuthEndpoint } from "better-auth/api";
import { APIError } from "better-auth/api";
import * as z from "zod";
import { db } from "@appstrate/db/client";
import { oauthClient } from "../schema.ts";
import {
  CliTokenError,
  exchangeDeviceCodeForTokens,
  revokeRefreshToken,
  rotateRefreshToken,
} from "../services/cli-tokens.ts";

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
    },
  };
}
