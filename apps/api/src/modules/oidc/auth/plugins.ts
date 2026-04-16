// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth plugins contributed by the OIDC module.
 *
 * Wires the `@better-auth/oauth-provider` plugin onto the platform Better
 * Auth singleton so Appstrate acts as an OAuth 2.1 / OIDC authorization
 * server. The flow is **polymorphic** — the same plugin handles two distinct
 * client scoping levels, discriminated by `oauth_clients.level`:
 *
 *   1. **Org-level** (`level: "org"`): dashboard users (org operators) scoped
 *      to a single organization pinned at client creation. Tokens carry
 *      `actor_type: "dashboard_user"` + `org_id` + `org_role`.
 *   2. **Application-level** (`level: "application"`): application end-users
 *      scoped to a single application. Tokens carry `actor_type: "end_user"`
 *      + `application_id` + `end_user_id`.
 *
 * `customAccessTokenClaims` reads the parsed `metadata` JSON column for the
 * active OAuth client and dispatches to `buildOrgLevelClaims` or
 * `buildApplicationLevelClaims` accordingly. All claim names are RFC 9068 / OIDC Core
 * snake_case.
 *
 * The JWT plugin is bundled automatically by oauth-provider
 * (disableJwtPlugin defaults to false). The JWKS is served at
 * `/api/auth/jwks`, OIDC discovery at `/api/auth/.well-known/openid-configuration`,
 * and the token / authorize / userinfo / revoke / introspect endpoints at
 * `/api/auth/oauth2/*`.
 *
 * Client secret storage matches the `oauth-admin` service hash (SHA-256 hex).
 */

import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { getEnv } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { user as userTable } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";
import { getOrgSettings } from "../../../services/organizations.ts";
import {
  resolveOrCreateEndUser,
  UnverifiedEmailConflictError,
  AppSignupClosedError,
  loadAppById,
} from "../services/enduser-mapping.ts";
import {
  OrgSignupClosedError,
  loadClientSignupPolicy,
  resolveOrCreateOrgMembership,
} from "../services/orgmember-mapping.ts";
import { hashSecret } from "../services/oauth-admin.ts";
import { socialOverridePlugin } from "../services/ba-social-override-plugin.ts";
import { oidcGuardsPlugin } from "./guards.ts";
import { APPSTRATE_SCOPES } from "./scopes.ts";

export type ActorType = "dashboard_user" | "end_user" | "user";
export type OrgRoleClaim = "owner" | "admin" | "member" | "viewer";

export interface ClientMetadata {
  level?: "org" | "application" | "instance";
  referencedOrgId?: string;
  referencedApplicationId?: string;
  /**
   * The OAuth client id — stashed by `createClient` so the
   * `customAccessTokenClaims` closure can recover the client identity and
   * look up mutable policy (e.g. `allowSignup` / `signupRole`) via
   * `loadClientSignupPolicy`. The Better Auth oauth-provider plugin does not
   * pass `client.clientId` to the closure directly.
   */
  clientId?: string;
}

/**
 * Constant-time comparison of the SHA-256 hex digest of `clientSecret`
 * against the stored hash. Uses `crypto.timingSafeEqual` on raw buffers
 * so the comparison cost does not depend on the position of the first
 * byte mismatch (prevents timing side channels on secret verification).
 *
 * `timingSafeEqual` requires equal-length buffers — we early-return on
 * length mismatch, which is safe because the stored hash length is a
 * public constant (64 hex chars) and does not leak secret material.
 */
async function sha256HexVerify(clientSecret: string, storedHash: string): Promise<boolean> {
  const computed = await hashSecret(clientSecret);
  if (computed.length !== storedHash.length) return false;
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return timingSafeEqual(a, b);
}

export interface OidcBetterAuthPluginsOptions {
  /**
   * ClientIds of first-party (`skip_consent = true`) OAuth clients known at
   * boot. Forwarded to `oauthProvider({ cachedTrustedClients })` so the
   * plugin's in-memory TTLCache short-circuits the DB lookup on authorize /
   * introspect / revoke for trusted clients. Static snapshot — clients
   * promoted to first-party post-boot fall back to the regular DB lookup
   * until the next restart. See `listFirstPartyClientIds` in
   * `services/oauth-admin.ts`.
   */
  cachedTrustedClientIds?: readonly string[];
}

export function oidcBetterAuthPlugins(opts: OidcBetterAuthPluginsOptions = {}): unknown[] {
  const env = getEnv();
  const validAudiences = [env.APP_URL, `${env.APP_URL}/api/auth`];
  const cachedTrustedClients =
    opts.cachedTrustedClientIds && opts.cachedTrustedClientIds.length > 0
      ? new Set(opts.cachedTrustedClientIds)
      : undefined;
  return [
    oidcGuardsPlugin({ validAudiences }),
    socialOverridePlugin(),
    jwt({
      jwks: { keyPairConfig: { alg: "ES256" } },
    }),
    oauthProvider({
      loginPage: "/api/oauth/login",
      consentPage: "/api/oauth/consent",
      scopes: [...APPSTRATE_SCOPES],
      validAudiences,
      cachedTrustedClients,
      storeClientSecret: {
        hash: hashSecret,
        verify: sha256HexVerify,
      },

      /**
       * Polymorphic claim builder. Branches on `metadata.level` (set at
       * client registration via `services/oauth-admin.ts`) and returns a
       * snake_case claim payload compatible with RFC 9068 + OIDC Core.
       */
      customAccessTokenClaims: async ({ user, metadata }) =>
        buildClaimsForClient(user ?? null, metadata as ClientMetadata | undefined),

      /**
       * Surface the same polymorphic claims on /userinfo so satellites can
       * read identity without decoding the JWT themselves. The Better Auth
       * oauth-provider plugin only passes us `{ user, scopes, jwt }` —
       * `jwt` is the decoded custom claims object from the access token,
       * so we can forward its identity claims verbatim.
       */
      customUserInfoClaims: async ({ jwt, user }) => {
        const claims = (jwt ?? {}) as Record<string, unknown>;
        const actorType = claims.actor_type;
        if (actorType !== "dashboard_user" && actorType !== "end_user" && actorType !== "user") {
          return {};
        }
        const base = {
          actor_type: actorType,
          email: str(claims.email) ?? user?.email,
          name: str(claims.name) ?? user?.name,
        };
        if (actorType === "end_user") {
          return {
            ...base,
            org_id: strOrNull(claims.org_id),
            application_id: strOrNull(claims.application_id),
            end_user_id: strOrNull(claims.end_user_id),
          };
        }
        const withVerified = {
          ...base,
          email_verified:
            typeof claims.email_verified === "boolean" ? claims.email_verified : false,
        };
        if (actorType === "dashboard_user") {
          return {
            ...withVerified,
            org_id: strOrNull(claims.org_id),
            org_role: strOrNull(claims.org_role),
          };
        }
        return withVerified;
      },
    }),
  ];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function strOrNull(value: unknown): string | null {
  return str(value) ?? null;
}

/**
 * Enforce realm isolation at token-mint time. The BA `user.realm` column
 * segregates audiences sharing the user table — platform operators
 * (`"platform"`) vs end-users of application-level OIDC clients
 * (`"end_user:<applicationId>"`). Without this check, a session minted
 * under one audience could mint a token for another (e.g. end-user of
 * app A requesting a token for app B, or a platform admin requesting an
 * end-user token for their own app).
 *
 * Throws RFC 6749 `access_denied` on mismatch — the satellite client
 * renders a clean auth error instead of a generic 500. Users recover by
 * logging out + re-authenticating with an account provisioned for the
 * target audience.
 *
 * Legacy users with NULL realm (pre-migration rows, should not exist
 * after 0001_add_user_realm due to the default clause) are treated as
 * `"platform"` — safer default since the request-time realm guard in the
 * auth pipeline already blocks non-platform sessions from platform
 * routes.
 */
async function assertUserRealm(
  userId: string,
  expected: string,
  context: { clientLevel: string; applicationId?: string | null; orgId?: string | null },
): Promise<void> {
  const [row] = await db
    .select({ realm: userTable.realm })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const actual = row?.realm ?? "platform";
  if (actual === expected) return;
  logger.warn("oidc: realm mismatch at token mint — rejecting", {
    module: "oidc",
    userId,
    expected,
    actual,
    clientLevel: context.clientLevel,
    applicationId: context.applicationId ?? null,
    orgId: context.orgId ?? null,
  });
  throw new APIError("FORBIDDEN", {
    error: "access_denied",
    error_description:
      "This account is not permitted to sign in to this application. Sign out and use an account provisioned for this audience.",
  });
}

/**
 * Dispatch on `metadata.level`. Defensive fallback returns `{}` so the
 * plugin still mints a token — at worst the strategy rejects it at verify
 * time because `actor_type` is missing.
 */
async function buildClaimsForClient(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean } | null,
  metadata: ClientMetadata | undefined,
): Promise<Record<string, unknown>> {
  if (!user) return {};
  const level = metadata?.level;
  if (level === "instance") {
    return buildInstanceLevelClaims(user);
  }
  if (level === "org") {
    return buildOrgLevelClaims(user, metadata!);
  }
  if (level === "application") {
    return buildApplicationLevelClaims(user, metadata!);
  }
  logger.warn("oidc: oauth_client metadata missing level — rejecting token", {
    module: "oidc",
    userId: user.id,
  });
  throw new APIError("BAD_REQUEST", {
    message: "OAuth client metadata missing level — cannot issue token",
  });
}

async function buildInstanceLevelClaims(user: {
  id: string;
  email: string;
  name?: string | null;
  emailVerified?: boolean;
}): Promise<Record<string, unknown>> {
  // Instance clients serve platform audiences — dashboard SPA + satellite
  // admin tools. Reject end-user realm sessions so an OIDC token minted
  // under app A's scope cannot be replayed to mint an instance token.
  await assertUserRealm(user.id, "platform", { clientLevel: "instance" });
  // Instance tokens carry NO org or application context. The user is a
  // Better Auth user who may belong to multiple organizations — org is
  // resolved per-request via X-Org-Id after authentication.
  return {
    actor_type: "user",
    email: user.email,
    email_verified: user.emailVerified === true,
    name: user.name ?? user.email,
  };
}

async function buildOrgLevelClaims(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean },
  metadata: ClientMetadata,
): Promise<Record<string, unknown>> {
  const orgId = metadata.referencedOrgId;
  if (!orgId) {
    logger.warn("oidc: org-level client missing referencedOrgId — rejecting token", {
      module: "oidc",
      userId: user.id,
    });
    throw new APIError("BAD_REQUEST", {
      message: "Invalid OAuth client configuration",
    });
  }

  // Dashboard SSO gate: org must have opted in via
  // orgSettings.dashboardSsoEnabled. Mirrors the interactive-flow gate in
  // routes.ts/loadPageContext — this is the authoritative token-mint check
  // that also catches non-interactive flows (refresh, client_credentials).
  const orgSettings = await getOrgSettings(orgId);
  if (orgSettings.dashboardSsoEnabled !== true) {
    logger.warn("oidc: dashboard SSO disabled for org — rejecting token", {
      module: "oidc",
      userId: user.id,
      orgId,
    });
    throw new APIError("FORBIDDEN", {
      error: "access_denied",
      error_description: "Dashboard SSO is disabled for this organization.",
    });
  }

  // Org-level clients serve platform audiences (dashboard users mapped to
  // org_members). Reject end-user realm sessions — an end-user of app A
  // cannot become a dashboard user of org X by OIDC replay.
  await assertUserRealm(user.id, "platform", { clientLevel: "org", orgId });

  // Load the mutable signup policy via the short-TTL client cache. Falls
  // back to the "closed" default if the client was deleted/disabled or its
  // metadata drifted — better to reject a legitimate mint than silently
  // auto-join to a wrong role.
  const loaded = metadata.clientId ? await loadClientSignupPolicy(metadata.clientId) : null;
  const policy: { allowSignup: boolean; signupRole: "admin" | "member" | "viewer" } =
    loaded && loaded.level === "org" && loaded.orgId === orgId
      ? { allowSignup: loaded.allowSignup, signupRole: loaded.signupRole }
      : { allowSignup: false, signupRole: "member" };

  // Resolve or create the membership. For existing members this is a
  // single SELECT (the proactive call in routes.ts already created the row
  // for new members during password login / register; this re-check is a
  // no-op for them). For social / magic-link flows where the proactive call
  // never ran, the auto-join happens here.
  //
  // NOTE: the BA `databaseHooks.user.create.before` guard
  // (`auth/signup-guard.ts`) already blocks brand-new BA users for closed
  // org-level clients BEFORE they reach this point. This path remains as
  // defense in depth for existing-but-unaffiliated BA users (e.g. a user
  // who created an account elsewhere and is now trying to access a closed
  // client).
  try {
    const resolved = await resolveOrCreateOrgMembership(
      { id: user.id, email: user.email },
      orgId,
      policy,
    );
    return {
      actor_type: "dashboard_user",
      email: user.email,
      email_verified: user.emailVerified === true,
      name: user.name ?? user.email,
      org_id: orgId,
      org_role: resolved.role,
    };
  } catch (err) {
    if (err instanceof OrgSignupClosedError) {
      logger.warn("oidc: user is not a member of the pinned org — rejecting token", {
        module: "oidc",
        userId: user.id,
        orgId,
      });
      // Structured OAuth2 error so satellites (portal) can render a clean
      // membership-error page instead of a generic 500. Uses RFC 6749
      // `access_denied` since RFC does not define a more specific code.
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        error_description:
          "Registration is disabled for this application. Contact your administrator to be added to the organization.",
      });
    }
    throw err;
  }
}

async function buildApplicationLevelClaims(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean },
  metadata: ClientMetadata,
): Promise<Record<string, unknown>> {
  const applicationId = metadata.referencedApplicationId;
  if (!applicationId) {
    logger.warn(
      "oidc: application-level client missing referencedApplicationId — rejecting token",
      {
        module: "oidc",
        userId: user.id,
      },
    );
    throw new Error(
      "oidc: application-level oauth client missing referencedApplicationId in metadata",
    );
  }
  const app = await loadAppById(applicationId);
  if (!app) {
    logger.warn("oidc: application referenced by oauth_client has been deleted", {
      module: "oidc",
      userId: user.id,
      applicationId,
    });
    throw new Error("oidc: referenced application not found");
  }

  // Application-level tokens are end-user tokens. Enforce that the
  // authenticating BA user was provisioned for THIS application — reject
  // platform admins (realm="platform") and end-users of a different app
  // (realm="end_user:B"). Per decision #2 (no cross-audience sharing),
  // a platform admin wanting to test their own app as an end-user must
  // re-signup with a separate account.
  await assertUserRealm(user.id, `end_user:${applicationId}`, {
    clientLevel: "application",
    applicationId,
  });
  // Load the signup policy via the short-TTL cache — closed default on any
  // lookup failure. Same rationale as `buildOrgLevelClaims`.
  const loaded = metadata.clientId ? await loadClientSignupPolicy(metadata.clientId) : null;
  const signupPolicy = {
    allowSignup:
      loaded?.level === "application" &&
      loaded.applicationId === applicationId &&
      loaded.allowSignup,
  };

  // NOTE: this call may be the SECOND invocation for a given login —
  // `routes.ts` POST /api/oauth/login pre-resolves the end-user to surface
  // `UnverifiedEmailConflictError` as a 409 before the redirect chain. That
  // first call is idempotent (step-1 SELECT lookup via `findLinkedEndUser`
  // on repeat calls), so this second invocation is a no-op for the happy
  // path. Do NOT add observable side effects here without making them
  // "first-call only" — see the matching warning in routes.ts.
  try {
    const resolved = await resolveOrCreateEndUser(
      {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        emailVerified: user.emailVerified === true,
      },
      app,
      signupPolicy,
    );
    return {
      actor_type: "end_user",
      email: resolved.email ?? user.email,
      name: resolved.name ?? user.name ?? user.email,
      org_id: resolved.orgId,
      application_id: resolved.applicationId,
      end_user_id: resolved.endUserId,
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
    if (err instanceof AppSignupClosedError) {
      logger.warn("oidc: end-user signup blocked by client policy", {
        module: "oidc",
        applicationId: err.applicationId,
        authUserId: err.authUserId,
      });
      // Map to a structured OAuth2 error so downstream satellites (portal)
      // can render a "contact your admin" page instead of a generic 500.
      throw new APIError("FORBIDDEN", {
        error: "access_denied",
        error_description:
          "Sign-up is disabled for this application. Ask your administrator to create your account before signing in.",
      });
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
