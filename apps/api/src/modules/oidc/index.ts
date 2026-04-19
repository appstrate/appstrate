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
import { oidcBeforeSignupGuard, oidcAfterSignupHandler } from "./auth/signup-guard.ts";
import {
  createOidcRouter,
  createOAuthClientSchema,
  updateOAuthClientSchema,
  smtpConfigUpsertSchema,
  socialProviderUpsertSchema,
} from "./routes.ts";
import { oidcPaths } from "./openapi/paths.ts";
import { oidcSchemas } from "./openapi/schemas.ts";
import {
  cliRefreshToken,
  deviceCode,
  jwks,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
} from "./schema.ts";
import {
  ensureInstanceClient,
  getInstanceClientId,
  listFirstPartyClientIds,
} from "./services/oauth-admin.ts";
import { ensureCliClient } from "./services/ensure-cli-client.ts";
import { syncInstanceClientsFromEnv } from "./services/instance-client-sync.ts";
import { oidcRealmResolver } from "./services/oidc-realm-resolver.ts";
import { setRealmResolver } from "@appstrate/db/auth";

// Snapshot of first-party clientIds captured at `init()` time and forwarded
// to `oauthProvider({ cachedTrustedClients })` when `betterAuthPlugins()` is
// invoked — the boot sequence calls `getModuleContributions()` after every
// module's `init()` has completed (see `apps/api/src/lib/boot.ts`).
let cachedTrustedClientIds: readonly string[] = [];

const oidcModule: AppstrateModule = {
  manifest: { id: "oidc", name: "OIDC Identity Provider", version: "1.0.0" },

  async init(ctx: ModuleInitContext) {
    await ctx.applyMigrations("oidc", resolve(import.meta.dir, "drizzle/migrations"), {
      requireCoreTables: ["end_users", "user", "session", "organizations", "applications"],
    });
    // Install the realm resolver so the BA user-create hook tags new
    // end-user rows with `realm="end_user:<applicationId>"`. Platform-side
    // signups (dashboard, org invitation, instance/org-level OIDC clients)
    // keep the default "platform" realm. See the resolver file header and
    // `packages/db/src/auth.ts::setRealmResolver` for the full contract.
    setRealmResolver(oidcRealmResolver);
    // Auto-provision the instance-level first-party OIDC client for the
    // platform dashboard SPA. Idempotent — skips if one already exists.
    const env = getEnv();
    const clientId = await ensureInstanceClient(env.APP_URL);
    logger.info("OIDC platform client ready", { module: "oidc", clientId });
    // Auto-provision the instance-level OAuth client for the official
    // `appstrate` CLI (device-flow login). Deterministic clientId
    // (`appstrate-cli`) so the distributed binary is zero-config per
    // install. Idempotent. Runs before env-declared satellites for the
    // same `created_at`-ordering rationale as the platform client.
    const cliClientId = await ensureCliClient();
    logger.info("OIDC CLI client ready", { module: "oidc", clientId: cliClientId });
    // Reconcile env-declared satellite instance clients (admin dashboards,
    // second-party web apps). Runs AFTER `ensureInstanceClient` so the
    // platform client always has the earliest `created_at` — see
    // `getInstanceClientId()` for why that ordering matters.
    await syncInstanceClientsFromEnv();
    // Snapshot first-party clientIds AFTER both provisioning steps — the
    // platform client + any env-declared satellites with `skipConsent: true`
    // are now present in the DB.
    cachedTrustedClientIds = await listFirstPartyClientIds();
    logger.info("OIDC cached trusted clients snapshotted", {
      module: "oidc",
      count: cachedTrustedClientIds.length,
    });
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
    "/api/oauth/magic-link",
    "/api/oauth/magic-link/confirm",
    "/api/oauth/forgot-password",
    "/api/oauth/reset-password",
    "/api/oauth/assets/social-sign-in.js",
    // Device-flow verification pages. `GET /activate` must be publicly
    // reachable so an unauthenticated user lands on the entry form and
    // gets redirected to `/auth/login?returnTo=...` with the user_code
    // preserved. `POST /activate*` are CSRF-gated internally.
    "/activate",
    "/activate/approve",
    "/activate/deny",
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ],

  authStrategies() {
    return [oidcAuthStrategy];
  },

  betterAuthPlugins() {
    return oidcBetterAuthPlugins({ cachedTrustedClientIds });
  },

  drizzleSchemas() {
    // Names must match the camelCase model ids Better Auth's oauth-provider,
    // jwt, and device-authorization plugins use internally (see
    // `@better-auth/oauth-provider` `schema`, `better-auth/plugins/jwt/schema`,
    // and `better-auth/plugins/device-authorization/schema`).
    return {
      jwks,
      oauthClient,
      oauthAccessToken,
      oauthRefreshToken,
      oauthConsent,
      deviceCode,
      cliRefreshToken,
    };
  },

  openApiPaths() {
    return oidcPaths;
  },

  openApiComponentSchemas() {
    return oidcSchemas;
  },

  openApiTags() {
    return [
      { name: "OAuth Clients", description: "OAuth 2.1 client registry for end-user auth" },
      {
        name: "Application Auth Config",
        description:
          "Per-application SMTP + social OAuth App configuration for `level: application` OIDC clients",
      },
      {
        name: "Device Authorization",
        description: "RFC 8628 device-authorization grant for CLI and other browserless clients",
      },
    ];
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
      {
        method: "PUT",
        path: "/api/applications/{id}/smtp-config",
        jsonSchema: z.toJSONSchema(smtpConfigUpsertSchema) as Record<string, unknown>,
        description: "Upsert per-application SMTP configuration",
      },
      {
        method: "PUT",
        path: "/api/applications/{id}/social-providers/{provider}",
        jsonSchema: z.toJSONSchema(socialProviderUpsertSchema) as Record<string, unknown>,
        description: "Upsert per-application social auth provider",
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

  hooks: {
    // Blocks the creation of orphan Better Auth users when a visitor tries
    // to sign up through an org-level OAuth client with `allow_signup=false`.
    // The guard reads the signed `oidc_pending_client` cookie set by the
    // OIDC entry pages (`GET /api/oauth/{login,register,magic-link}`) to
    // identify which client is in play — the cookie survives the social
    // round-trip that BA's native `/api/auth/sign-in/social` bounces through.
    // Pass-through on every signup that is not gated by an org-level client.
    beforeSignup: async (email, ctx) => {
      await oidcBeforeSignupGuard({ user: { email }, headers: ctx?.headers ?? null });
    },
    // Symmetric post-signup: on a BA user freshly created through an
    // org-level client with `allowSignup=true`, auto-join them to the org
    // before the social flow continues to `/api/auth/oauth2/authorize`. See
    // `oidcAfterSignupHandler` docstring for why `buildOrgLevelClaims` alone
    // isn't enough for the social code path.
    afterSignup: async (user, ctx) => {
      await oidcAfterSignupHandler({ user, headers: ctx?.headers ?? null });
    },
  },
};

export default oidcModule;
