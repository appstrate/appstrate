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
 * The owning Appstrate `applicationId` is stashed in the plugin-native
 * `oauth_client.metadata` JSON column at client registration time by
 * `services/oauth-admin.ts`. The plugin parses it on every token/id_token
 * mint and forwards it as the `metadata` closure argument of
 * `customAccessTokenClaims` and `customIdTokenClaims`. We deliberately do
 * NOT use the `referenceId` closure argument: in this plugin version it
 * reflects `postLogin.consentReferenceId` (a consent-time account-selection
 * feature we don't use), not `oauth_client.reference_id`. The column is
 * still populated in lockstep with `metadata.applicationId` for the
 * plugin's own client-ACL path (`clientReference` + admin CRUD gates).
 *
 * The OIDC auth strategy picks the claims up from the Bearer JWT and
 * sets the `endUser` context for every subsequent core route, so the
 * strict end-user run visibility filter kicks in automatically.
 *
 * Client secret storage matches the existing `oauth-admin` service hash
 * (SHA-256 hex) so clients registered via our admin API are accepted
 * by the plugin's token endpoint without a migration.
 */

import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { getEnv } from "@appstrate/env";
import { logger } from "../../../lib/logger.ts";
import { OIDC_ALLOWED_SCOPES } from "../../../lib/permissions.ts";
import {
  resolveOrCreateEndUser,
  UnverifiedEmailConflictError,
} from "../services/enduser-mapping.ts";
import { hashSecret } from "../services/oauth-admin.ts";
import { oidcGuardsPlugin } from "./guards.ts";

/**
 * OIDC protocol scopes that grant no Appstrate permission. Required by the
 * oauth-provider plugin (`openid`/`profile`/`email`) and by every standard
 * OIDC client library. `offline_access` gates refresh-token issuance.
 */
export const OIDC_IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * Canonical scope vocabulary served by the OIDC module. Identity scopes
 * first, then core `Permission` strings drawn from `OIDC_ALLOWED_SCOPES` —
 * no second vocabulary, no translation layer. The scope `agents:run`
 * grants the `agents:run` permission verbatim.
 *
 * The admin UI, the consent page, and `/.well-known/openid-configuration`
 * all read from this array via `GET /api/oauth/scopes`.
 */
export const APPSTRATE_SCOPES: readonly string[] = [
  ...OIDC_IDENTITY_SCOPES,
  ...OIDC_ALLOWED_SCOPES,
];

async function sha256HexVerify(clientSecret: string, storedHash: string): Promise<boolean> {
  const computed = await hashSecret(clientSecret);
  if (computed.length !== storedHash.length) return false;
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
      scopes: [...APPSTRATE_SCOPES],

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
        hash: hashSecret,
        verify: sha256HexVerify,
      },

      // `storeTokens` defaults to "hashed" in the plugin. Opaque access
      // tokens + refresh tokens are stored as SHA-256 hashes so a DB dump
      // cannot be replayed against the token endpoint. We rely on the
      // default — declaring it explicitly would be redundant noise.

      // OAuth 2.1 default: PKCE required for every authorization code flow.
      // Opt-out only possible per-client via `requirePKCE: false` on the row.
      // (We enforce `requirePKCE: true` at admin-API client creation time.)

      /**
       * Inject `endUserId` + `applicationId` + `orgId` custom claims into
       * every access token so the OIDC auth strategy can resolve the
       * end-user from the JWT alone, without a DB lookup by email. Called
       * once per token mint, including on refresh.
       *
       * `metadata` is `parseClientMetadata(oauth_client.metadata)` — the
       * plugin parses the JSON column for us. `services/oauth-admin.ts`
       * writes `{ applicationId }` there at registration time.
       *
       * Errors here fail the token issuance — we deliberately propagate
       * `UnverifiedEmailConflictError` so the end-user sees a "verify your
       * email" message instead of a silently-succeeded login that later
       * fails on every scoped request.
       */
      customAccessTokenClaims: async ({ user, metadata }) => buildEndUserClaims(user, metadata),

      // NOTE: `customIdTokenClaims` is deliberately NOT wired. The plugin
      // mints access_token + id_token in parallel via Promise.all in
      // `createUserTokens`. Wiring both closures triggers two concurrent
      // `resolveOrCreateEndUser` calls on the first mint for a new user
      // and races on the `end_users` unique index. Satellites that need
      // `applicationId` read it from the access token (custom claims) or
      // from `/userinfo` (mirrored via `customUserInfoClaims` below).

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
 * Shared resolver for the `customAccessTokenClaims` closure (and any other
 * closure that mints end-user claims in the future). Reads the owning
 * Appstrate `applicationId` from the plugin-provided `metadata` (which is
 * already parsed JSON from `oauth_client.metadata`),
 * resolves/creates the end-user, and returns the custom claim set. Returns
 * an empty object when context is missing so the plugin still mints a valid
 * token — just without end-user context.
 *
 * Propagates `UnverifiedEmailConflictError` so the caller (the plugin) can
 * surface it to the end-user instead of silently succeeding and then failing
 * on every scoped request.
 *
 * `user` is declared optional by the plugin's TypeScript surface to cover
 * the `client_credentials` path. We do not advertise that grant at client
 * registration (`services/oauth-admin.ts` only sets `["authorization_code",
 * "refresh_token"]`), so the branch is not reachable today — but we keep
 * the defensive null-check to satisfy the plugin's type contract.
 */
async function buildEndUserClaims(
  user:
    | { id: string; email: string; name?: string | null; emailVerified?: boolean }
    | null
    | undefined,
  metadata: Record<string, unknown> | undefined,
): Promise<Record<string, string>> {
  if (!user) return {};
  const applicationId =
    metadata && typeof metadata.applicationId === "string" ? metadata.applicationId : undefined;
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
}

export { getOidcAuthApi } from "./api.ts";
