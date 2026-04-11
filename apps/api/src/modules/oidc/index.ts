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
 *    tokens. Better Auth serves `/api/auth/oauth2/*`, `/.well-known/*`, and
 *    `/api/auth/jwks` automatically — no core route mount needed.
 *  - `authStrategies()` contributes a strategy that matches `Bearer ey…`,
 *    verifies the JWT via the local JWKS, looks up the end-user via this
 *    module's shadow table, and emits an `AuthResolution` with `endUser`
 *    in context. Core's strict run-visibility filter then applies.
 *  - `createRouter()` mounts OAuth client admin endpoints (enable/rotate/
 *    disable) and server-rendered login + consent pages.
 *  - `init()` runs module-owned Drizzle migrations for the Better Auth
 *    oauth-provider tables plus the `oidc_end_user_profiles` shadow table.
 */

import { resolve } from "node:path";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";

const oidcModule: AppstrateModule = {
  manifest: { id: "oidc", name: "OIDC Identity Provider", version: "1.0.0" },

  async init(ctx: ModuleInitContext) {
    await ctx.applyMigrations("oidc", resolve(import.meta.dir, "drizzle/migrations"), {
      requireCoreTables: ["end_users", "user", "session"],
    });
  },

  features: { oidc: true },
};

export default oidcModule;
