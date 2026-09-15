// SPDX-License-Identifier: Apache-2.0

/**
 * End-user token verification service.
 *
 * Verifies the ES256-signed JWT access tokens the Better Auth `oauth-provider`
 * plugin issues, through `verifyJwsAccessToken`. The key set is read from the
 * Better Auth singleton in-process (`auth.api.getJwks()`) rather than over HTTP
 * to `${APP_URL}/api/auth/jwks`, so verification works under Hono's
 * `app.request()`, in tests and in air-gapped deployments, and always sees the
 * keys the local plugin mints with.
 *
 * Rotation safety is upstream's: it trusts a cached key set for 300 s under
 * `jwksCacheKey`, and a token whose `kid` that set does not carry forces one
 * refetch before the token is refused. The `jwt` plugin rotates its ES256
 * keypair every 90 days with a 7-day grace window; both halves of the window
 * therefore verify within a single call, with no process restart.
 */

import * as jose from "jose";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { getEnv } from "@appstrate/env";
import type { OrgRole } from "@appstrate/core/permissions";
import { logger } from "../../../lib/logger.ts";
import { getOidcAuthApi } from "../auth/api.ts";
import { getErrorMessage } from "@appstrate/core/errors";
import { getEndUserVerifyAudiences } from "../../../lib/audiences.ts";

/** Normalize a JWT `aud` (string | string[] | undefined) to a string array. */
function normalizeAudiences(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === "string");
  return [];
}

/**
 * Polymorphic access-token claim shape. Every OIDC-minted token carries
 * `actor_type` as the discriminant. Dashboard-user tokens additionally
 * carry `org_id` + `org_role`; end-user tokens additionally carry
 * `space_id` + `end_user_id`. `sub` is always present (Better Auth
 * `user.id`).
 */
export interface AccessTokenClaims {
  /** Better Auth `user.id` (the JWT `sub` claim). */
  authUserId: string;
  /** JWT `aud` normalized to an array — the RFC 8707 resources this token is for. */
  audiences: string[];
  /** OAuth2 `azp` (authorized party) — the `client_id` of the issuing client. */
  clientId?: string;
  /** Discriminant — see polymorphic fields below. */
  actorType?: "dashboard_user" | "end_user" | "user";
  email?: string;
  emailVerified?: boolean;
  name?: string;
  /** Space-separated scope string as issued by the oauth-provider plugin. */
  scope?: string;
  /** Org scope for dashboard users and (derived) for end-users. */
  orgId?: string;
  /** Dashboard flow: `owner` / `admin` / `member` / `guest`. */
  orgRole?: OrgRole;
  /** End-user flow: owning space id. */
  spaceId?: string;
  /** End-user flow: `eu_…` id of the impersonated end-user. */
  endUserId?: string;
  /** CLI flow: refresh-token family id this access token was issued
   *  alongside. The OIDC strategy gates the token on the family's
   *  revocation state — absent for non-CLI instance tokens. */
  cliFamilyId?: string;
}

/** Supplies the key set access tokens are verified against. */
export type JwksFetch = () => Promise<jose.JSONWebKeySet>;

/**
 * Production source: the Better Auth singleton's `jwt` plugin endpoint, called
 * in-process. Empty is an error — a keyless set would refuse every token.
 */
const fetchLocalJwks: JwksFetch = async () => {
  const api = getOidcAuthApi();
  const result = await api.getJwks({ headers: new Headers() });
  const keys = result?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("oidc: jwks endpoint returned no keys");
  }
  return { keys };
};

let jwksFetch: JwksFetch = fetchLocalJwks;
/** Stable identity the upstream verifier caches this source's key set under. */
let jwksCacheKey: object = {};

/**
 * Verify a Bearer access token and return its claims, or `null` if the token
 * is malformed, has an invalid signature, is expired, or fails issuer/audience
 * checks. Never throws — designed to be called from the auth middleware hot
 * path where the token is just as likely to be a random opaque string.
 *
 * Pass `deps.jwks` to inject a key-set source (unit tests that pin a specific
 * keypair without rebuilding the Better Auth singleton). Production callers
 * pass nothing and read the singleton through the cached module source.
 */
export async function verifyEndUserAccessToken(
  token: string,
  deps?: { jwks?: JwksFetch },
): Promise<AccessTokenClaims | null> {
  const env = getEnv();
  // Better Auth's oauth-provider plugin mints tokens with `iss` set to
  // `${baseURL}${basePath}` — in this codebase that is `${APP_URL}/api/auth`
  // (see `packages/db/src/auth.ts` basePath). Verifying against `APP_URL`
  // alone rejects every real token.
  const issuer = `${env.APP_URL}/api/auth`;
  // Audience validation mirrors what the AS will mint (its `oauth_resources`
  // rows) — RFC 8707 enforcement already happens at the token endpoint, but the
  // local verifier adds defense-in-depth so a future plugin update that mints
  // tokens with an unexpected `aud` cannot slip through unchecked.
  //
  // The platform + AS base audiences plus one per-org MCP resource URI each
  // (`…/api/mcp/o/:org`), so an RFC 8707 audience-bound MCP token
  // (`resource=<…>/api/mcp/o/<id>` → `aud: <…>/api/mcp/o/<id>`) verifies here.
  // The list is owned + cached by the audiences module (base computed locally,
  // so verification never depends on the AS plugin having run; cache rebuilt
  // only when the org set changes, so this hot path stays O(1)). jose passes
  // when the token's `aud` intersects the list; the per-org MCP resource server
  // then additionally requires ITS exact URI in `aud` (RFC 8707 MUST),
  // confining the token to that one org, and an MCP-scoped token reaching other
  // routes is contained by the outbound audience guard + RBAC.
  const audience = getEndUserVerifyAudiences();

  let payload: jose.JWTPayload;
  try {
    payload = await verifyJwsAccessToken(token, {
      jwksFetch: deps?.jwks ?? jwksFetch,
      // An injected source belongs to its caller: keep it out of the cache the
      // module source owns, so neither can serve the other's keys.
      jwksCacheKey: deps?.jwks ? undefined : jwksCacheKey,
      verifyOptions: { issuer, audience, algorithms: ["ES256"] },
    });
  } catch (err) {
    logger.debug("oidc: verifyEndUserAccessToken failed", {
      module: "oidc",
      error: getErrorMessage(err),
    });
    return null;
  }

  if (!payload.sub) return null;
  const extra = payload as Record<string, unknown>;
  const actorType =
    extra.actor_type === "dashboard_user" ||
    extra.actor_type === "end_user" ||
    extra.actor_type === "user"
      ? (extra.actor_type as "dashboard_user" | "end_user" | "user")
      : undefined;
  const orgRole =
    typeof extra.org_role === "string" &&
    (extra.org_role === "owner" ||
      extra.org_role === "admin" ||
      extra.org_role === "member" ||
      extra.org_role === "guest")
      ? (extra.org_role as OrgRole)
      : undefined;
  return {
    authUserId: payload.sub,
    audiences: normalizeAudiences(payload.aud),
    clientId: typeof extra.azp === "string" ? extra.azp : undefined,
    actorType,
    email: typeof extra.email === "string" ? extra.email : undefined,
    emailVerified: typeof extra.email_verified === "boolean" ? extra.email_verified : undefined,
    name: typeof extra.name === "string" ? extra.name : undefined,
    scope: typeof extra.scope === "string" ? extra.scope : undefined,
    orgId: typeof extra.org_id === "string" ? extra.org_id : undefined,
    orgRole,
    spaceId: typeof extra.space_id === "string" ? extra.space_id : undefined,
    endUserId: typeof extra.end_user_id === "string" ? extra.end_user_id : undefined,
    cliFamilyId: typeof extra.cli_family_id === "string" ? extra.cli_family_id : undefined,
  };
}

/**
 * Test harness override — install the key set access tokens verify against, or
 * pass `null` to restore the Better Auth singleton as the source. Either way
 * the cached key set is dropped, so a test that rebuilds the singleton sees its
 * fresh ES256 keys on the next verify. Production callers use the `deps.jwks`
 * parameter instead.
 */
export function overrideJwks(fetch: JwksFetch | null): void {
  jwksFetch = fetch ?? fetchLocalJwks;
  jwksCacheKey = {};
}
