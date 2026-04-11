// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugins contributed by the OIDC module.
 *
 * Wires the `@better-auth/oauth-provider` plugin onto the platform Better
 * Auth singleton so Appstrate acts as an OAuth 2.1 / OIDC authorization
 * server for end-user satellites. The JWT plugin is bundled automatically
 * by oauth-provider (disableJwtPlugin defaults to false) — the JWKS is
 * served at `/api/auth/jwks`, OIDC discovery at
 * `/api/auth/.well-known/openid-configuration`, and the token, authorize,
 * userinfo, revoke, introspect endpoints at `/api/auth/oauth2/*`.
 *
 * The plugin reads/writes the `oauth_client`, `oauth_access_token`,
 * `oauth_refresh_token`, and `oauth_consent` tables owned by this module.
 * The Drizzle schema in `../schema.ts` was designed to match the plugin's
 * expected shape 1:1 so no schema reconciliation is required at runtime.
 *
 * Custom access token claims inject `endUserId` + `applicationId` by
 * resolving/creating the end-user via `resolveOrCreateEndUser()`. The OIDC
 * auth strategy then picks them up from the Bearer JWT and sets the
 * `endUser` context for every subsequent core route, so the strict
 * end-user run visibility filter kicks in automatically.
 *
 * Client secret storage matches the existing `oauth-admin` service hash
 * (SHA-256 hex) so clients registered via our admin API are accepted
 * by the plugin's token endpoint without a migration.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { getEnv } from "@appstrate/env";
import { logger } from "../../../lib/logger.ts";
import {
  resolveOrCreateEndUser,
  UnverifiedEmailConflictError,
} from "../services/enduser-mapping.ts";
import { getAuth } from "@appstrate/db/auth";
import { oidcGuardsPlugin } from "./guards.ts";

const APPSTRATE_SCOPES: string[] = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "agents",
  "agents:write",
  "runs",
  "runs:write",
  "connections",
  "connections:write",
];

/**
 * SHA-256 hex hash matching `services/oauth-admin.ts`'s `hashSecret`.
 * Wrapping it here so the plugin's `storeClientSecret.hash` hook uses the
 * exact same format that our admin API writes — otherwise newly-created
 * clients would be unverifiable.
 */
async function sha256HexHash(clientSecret: string): Promise<string> {
  const data = new TextEncoder().encode(clientSecret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Buffer.from(new Uint8Array(digest)).toString("hex");
}

async function sha256HexVerify(clientSecret: string, storedHash: string): Promise<boolean> {
  const computed = await sha256HexHash(clientSecret);
  if (computed.length !== storedHash.length) return false;
  // Constant-time compare.
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
}

export function oidcBetterAuthPlugins(): unknown[] {
  const env = getEnv();
  const validAudiences = [env.APP_URL, `${env.APP_URL}/api/auth`];
  return [
    // Guards must run BEFORE oauth-provider so that `hooks.before` can
    // reject malformed token/authorize requests and enforce per-IP rate
    // limits before any opaque token is minted or client_secret is
    // probed. See `guards.ts` for the full rationale.
    oidcGuardsPlugin({ validAudiences }),
    // JWT plugin MUST be present before oauth-provider so that token
    // signing uses ES256 keys rotated through the module-owned `jwks`
    // table. `oauth-provider` throws `jwt_config` at token mint time if
    // this plugin is missing from the chain.
    jwt({
      jwks: {
        keyPairConfig: { alg: "ES256" },
      },
    }),
    oauthProvider({
      // End-user facing pages served by this module (see `routes.ts`).
      loginPage: "/api/oauth/enduser/login",
      consentPage: "/api/oauth/enduser/consent",

      // Full canonical scope vocabulary. The strategy's `scopesToPermissions`
      // mapper translates these into core RBAC strings at request time.
      scopes: APPSTRATE_SCOPES,

      // `validAudiences` is what the plugin accepts on the RFC 8707
      // `resource` parameter at the token endpoint. It drives the
      // JWT-vs-opaque decision: `createUserTokens` only issues a JWT
      // access token when `audience && !disableJwtPlugin`. Without a
      // valid `resource`, the plugin mints opaque tokens that our OIDC
      // auth strategy cannot match (it fast-rejects on `Bearer ey…`).
      //
      // We accept both `APP_URL` and `APP_URL/api/auth` so satellites
      // can pass either the issuer or the Better Auth base URL as the
      // resource indicator. The module README's satellite integration
      // example documents `resource=<APP_URL>` as the canonical form.
      validAudiences,

      // Match our existing admin-API hash so clients created before/without
      // the plugin continue to work.
      storeClientSecret: {
        hash: sha256HexHash,
        verify: sha256HexVerify,
      },

      // OAuth 2.1 default: PKCE required for every authorization code flow.
      // Opt-out only possible per-client via `requirePKCE: false` on the row.
      // (We enforce `requirePKCE: true` at admin-API client creation time.)

      /**
       * Inject `endUserId` + `applicationId` + `orgId` custom claims into
       * every access token so the OIDC auth strategy can resolve the
       * end-user from the JWT alone, without a DB lookup by email. Called
       * once per token mint, including on refresh.
       *
       * The owning Appstrate `applicationId` is recovered from the client
       * metadata (stashed at `createClient` time — see
       * `services/oauth-admin.ts`). The plugin does NOT natively thread
       * `client.referenceId` through to this closure; `referenceId` here
       * only reflects the consent-flow reference, which we don't use.
       *
       * Errors here fail the token issuance — we deliberately propagate
       * `UnverifiedEmailConflictError` so the end-user sees a "verify your
       * email" message instead of a silently-succeeded login that later
       * fails on every scoped request.
       */
      customAccessTokenClaims: async ({ user, metadata }) => {
        if (!user) {
          // Client-credentials grant (no user) — nothing for us to inject.
          return {};
        }
        const applicationId =
          metadata && typeof metadata === "object" && typeof metadata.applicationId === "string"
            ? metadata.applicationId
            : undefined;
        if (!applicationId) {
          logger.warn(
            "oidc: oauth_client missing applicationId metadata — token will not carry end-user claims",
            { module: "oidc", userId: user.id },
          );
          return {};
        }
        try {
          const resolved = await resolveOrCreateEndUser(
            {
              id: user.id,
              email: user.email,
              name: user.name ?? null,
              emailVerified: user.emailVerified === true,
            },
            applicationId,
          );
          return {
            endUserId: resolved.endUserId,
            applicationId: resolved.applicationId,
            orgId: resolved.orgId,
          };
        } catch (err) {
          if (err instanceof UnverifiedEmailConflictError) {
            logger.warn("oidc: unverified-email conflict during token issuance", {
              module: "oidc",
              applicationId: err.applicationId,
              email: err.email,
            });
            throw err;
          }
          logger.error("oidc: end-user resolution failed during token issuance", {
            module: "oidc",
            userId: user.id,
            applicationId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },

      // Surface the same custom claims on the /userinfo endpoint so
      // satellites can read `endUserId` without decoding the JWT themselves.
      customUserInfoClaims: async ({ user, jwt }) => {
        const endUserId = jwt?.endUserId;
        const applicationId = jwt?.applicationId;
        return {
          ...(typeof endUserId === "string" ? { endUserId } : {}),
          ...(typeof applicationId === "string" ? { applicationId } : {}),
          ...(user?.name ? { name: user.name } : {}),
        };
      },
    }),
  ];
}

/**
 * Typed accessor for the Better Auth singleton's oauth-provider endpoints.
 * Keeping the `any` escape here instead of leaking better-auth generics
 * through the module's public surface — consumer code in `routes.ts` only
 * uses two endpoints (`signInEmail`, `oauth2Consent`) and stays strict on
 * its own types.
 */
export function getOidcAuthApi(): {
  signInEmail: (args: {
    body: { email: string; password: string; rememberMe?: boolean };
    headers: Headers;
    request?: Request;
    asResponse?: boolean;
  }) => Promise<Response | unknown>;
  oauth2Consent: (args: {
    body: { accept: boolean; scope?: string; oauth_query?: string };
    headers: Headers;
    request?: Request;
    asResponse?: boolean;
  }) => Promise<Response | unknown>;
} {
  const auth = getAuth() as unknown as {
    api: Record<string, (...args: unknown[]) => Promise<unknown>>;
  };
  return {
    signInEmail: auth.api.signInEmail as never,
    oauth2Consent: auth.api.oauth2Consent as never,
  };
}
