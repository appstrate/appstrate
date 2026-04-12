// SPDX-License-Identifier: Apache-2.0

/**
 * OIDC module — End-User Identity Provider for Appstrate applications.
 *
 * When loaded, turns each Appstrate application into an OAuth 2.1 /
 * OpenID Connect authorization server for its end-users. External apps
 * (satellites, mobile apps, partner integrations) register an OAuth client,
 * run the PKCE flow against `/api/auth/oauth2/*`, and exchange the resulting
 * access token as a Bearer JWT when calling core Appstrate routes.
 *
 * Architecture:
 *  - `betterAuthPlugins()` contributes `jwt` + `@better-auth/oauth-provider`
 *    at boot so the Better Auth singleton knows how to mint + sign end-user
 *    tokens. Better Auth serves `/api/auth/oauth2/*` and `/api/auth/jwks`
 *    automatically.
 *  - `authStrategies()` contributes a strategy that matches `Bearer ey…`,
 *    verifies the JWT via the local JWKS, looks up the end-user via this
 *    module's shadow table, and emits an `AuthResolution` with `endUser`
 *    in context. Core's strict run-visibility filter then applies.
 *  - `createRouter()` (mounted at the HTTP origin root by the platform)
 *    owns the `/api/oauth/*` admin endpoints, the server-rendered
 *    `/api/oauth/{login,consent}` pages, and the RFC-compliant
 *    `/.well-known/openid-configuration` + `/.well-known/oauth-authorization-server`
 *    discovery endpoints.
 *  - `init()` runs module-owned Drizzle migrations for the Better Auth
 *    oauth-provider tables plus the `oidc_end_user_profiles` shadow table.
 */

import { resolve } from "node:path";
import { z } from "zod";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { getEnv } from "@appstrate/env";
import { logger } from "../../lib/logger.ts";
import { oidcAuthStrategy } from "./auth/strategy.ts";
import { oidcBetterAuthPlugins } from "./auth/plugins.ts";
import { createOidcRouter, createOAuthClientSchema, updateOAuthClientSchema } from "./routes.ts";
import { oidcPaths } from "./openapi/paths.ts";
import { oidcSchemas } from "./openapi/schemas.ts";
import { jwks, oauthClient, oauthAccessToken, oauthRefreshToken, oauthConsent } from "./schema.ts";
import { ensureInstanceClient, getInstanceClientId } from "./services/oauth-admin.ts";

const oidcModule: AppstrateModule = {
  manifest: { id: "oidc", name: "OIDC Identity Provider", version: "1.0.0" },

  async init(ctx: ModuleInitContext) {
    await ctx.applyMigrations("oidc", resolve(import.meta.dir, "drizzle/migrations"), {
      requireCoreTables: ["end_users", "user", "session", "organizations", "applications"],
    });
    // Auto-provision the instance-level first-party OIDC client for the
    // platform dashboard SPA. Idempotent — skips if one already exists.
    const env = getEnv();
    const clientId = await ensureInstanceClient(env.APP_URL);
    logger.info("OIDC instance client ready", { module: "oidc", clientId });
  },

  // Router mounted at HTTP origin root. Declares full paths — `/api/oauth/*`
  // for business endpoints + `/.well-known/openid-configuration` +
  // `/.well-known/oauth-authorization-server` for RFC-compliant OIDC
  // discovery. See `createOidcRouter` in `routes.ts` for the spec
  // rationale behind serving well-known at the HTTP origin root.
  createRouter() {
    return createOidcRouter();
  },

  // OIDC admin routes are org-scoped (dashboard clients) — end_user clients
  // are created with a `referencedApplicationId` passed explicitly in the
  // request body. No `X-App-Id` header is required.
  publicPaths: [
    "/api/oauth/login",
    "/api/oauth/register",
    "/api/oauth/consent",
    "/api/oauth/logout",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ],

  authStrategies() {
    return [oidcAuthStrategy];
  },

  betterAuthPlugins() {
    return oidcBetterAuthPlugins();
  },

  drizzleSchemas() {
    // Names must match the camelCase model ids Better Auth's oauth-provider
    // and jwt plugins use internally (see `@better-auth/oauth-provider`
    // `schema` + `better-auth/plugins/jwt/schema`).
    return {
      jwks,
      oauthClient,
      oauthAccessToken,
      oauthRefreshToken,
      oauthConsent,
    };
  },

  openApiPaths() {
    return oidcPaths;
  },

  openApiComponentSchemas() {
    return oidcSchemas;
  },

  openApiTags() {
    return [{ name: "OAuth Clients", description: "OAuth 2.1 client registry for end-user auth" }];
  },

  openApiSchemas() {
    return [
      {
        method: "POST",
        path: "/api/oauth/clients",
        jsonSchema: z.toJSONSchema(createOAuthClientSchema) as Record<string, unknown>,
        description: "Create OAuth client",
      },
      {
        method: "PATCH",
        path: "/api/oauth/clients/{clientId}",
        jsonSchema: z.toJSONSchema(updateOAuthClientSchema) as Record<string, unknown>,
        description: "Update OAuth client",
      },
    ];
  },

  async appConfigContribution() {
    const clientId = await getInstanceClientId();
    if (!clientId) return {};
    const env = getEnv();
    // `callbackUrl` is published here so the SPA uses the exact redirect_uri
    // registered by `ensureInstanceClient()` — deriving it from
    // `window.location.origin` would break any deployment where the browser
    // origin diverges from `APP_URL` (reverse proxy, TLS termination, custom
    // subdomain), triggering `redirect_uri_mismatch` at `/oauth2/authorize`.
    return {
      oidc: {
        clientId,
        issuer: `${env.APP_URL}/api/auth`,
        callbackUrl: `${env.APP_URL}/auth/callback`,
      },
    };
  },

  features: { oidc: true },
};

export default oidcModule;
