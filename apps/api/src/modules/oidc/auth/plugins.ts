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

import { eq, and } from "drizzle-orm";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { getEnv } from "@appstrate/env";
import { db } from "@appstrate/db/client";
import { organizationMembers } from "@appstrate/db/schema";
import { logger } from "../../../lib/logger.ts";
import {
  resolveOrCreateEndUser,
  UnverifiedEmailConflictError,
  loadAppById,
} from "../services/enduser-mapping.ts";
import { hashSecret } from "../services/oauth-admin.ts";
import { oidcGuardsPlugin } from "./guards.ts";
import { APPSTRATE_SCOPES } from "./scopes.ts";

export type ActorType = "dashboard_user" | "end_user";
export type OrgRoleClaim = "owner" | "admin" | "member" | "viewer";

export interface ClientMetadata {
  level?: "org" | "application";
  referencedOrgId?: string;
  referencedApplicationId?: string;
}

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
    oidcGuardsPlugin({ validAudiences }),
    jwt({
      jwks: { keyPairConfig: { alg: "ES256" } },
    }),
    oauthProvider({
      loginPage: "/api/oauth/login",
      consentPage: "/api/oauth/consent",
      scopes: [...APPSTRATE_SCOPES],
      validAudiences,
      storeClientSecret: {
        hash: hashSecret,
        verify: sha256HexVerify,
      },

      /**
       * Polymorphic claim builder. Branches on `metadata.level` (set at
       * client registration via `services/oauth-admin.ts`) and returns a
       * snake_case claim payload compatible with RFC 9068 + OIDC Core.
       */
      customAccessTokenClaims: async ({ user, scopes, metadata }) =>
        buildClaimsForClient(user ?? null, metadata as ClientMetadata | undefined, scopes),

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
        if (actorType === "dashboard_user") {
          return {
            actor_type: "dashboard_user",
            email: stringOr(claims.email, user?.email),
            email_verified: boolOr(claims.email_verified, false),
            name: stringOr(claims.name, user?.name),
            org_id: stringOrNull(claims.org_id),
            org_role: stringOrNull(claims.org_role),
          };
        }
        if (actorType === "end_user") {
          return {
            actor_type: "end_user",
            email: stringOr(claims.email, user?.email),
            name: stringOr(claims.name, user?.name),
            org_id: stringOrNull(claims.org_id),
            application_id: stringOrNull(claims.application_id),
            end_user_id: stringOrNull(claims.end_user_id),
          };
        }
        return {};
      },
    }),
  ];
}

function stringOr(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === "string" && c.length > 0) return c;
  return undefined;
}
function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Dispatch on `metadata.level`. Defensive fallback returns `{}` so the
 * plugin still mints a token — at worst the strategy rejects it at verify
 * time because `actor_type` is missing.
 */
async function buildClaimsForClient(
  user: { id: string; email: string; name?: string | null; emailVerified?: boolean } | null,
  metadata: ClientMetadata | undefined,
  _scopes: string[] | undefined,
): Promise<Record<string, unknown>> {
  if (!user) return {};
  const level = metadata?.level;
  if (level === "org") {
    return buildOrgLevelClaims(user, metadata!);
  }
  if (level === "application") {
    return buildApplicationLevelClaims(user, metadata!);
  }
  logger.warn("oidc: oauth_client metadata missing level — token will carry no actor claims", {
    module: "oidc",
    userId: user.id,
  });
  return {};
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
    throw new Error("oidc: org-level oauth client missing referencedOrgId in metadata");
  }
  const [m] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.userId, user.id), eq(organizationMembers.orgId, orgId)))
    .limit(1);
  if (!m) {
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
        "The signed-in user is not a member of the organization pinned to this OAuth client.",
    });
  }
  return {
    actor_type: "dashboard_user",
    email: user.email,
    email_verified: user.emailVerified === true,
    name: user.name ?? user.email,
    org_id: orgId,
    org_role: m.role,
  };
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
  try {
    const resolved = await resolveOrCreateEndUser(
      {
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        emailVerified: user.emailVerified === true,
      },
      app,
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
