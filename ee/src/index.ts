// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `@appstrate/ee` — the commercial features of Appstrate, loaded through
 * `MODULES` like any module. Today: enterprise sign-in. An organization binds
 * its Microsoft Entra tenant to the instance's Microsoft sign-in (no app
 * registration or secret of its own), proves its email domains by DNS, and may
 * then require Microsoft for those addresses.
 */

import { z } from "zod";
import type { AppstrateModule, ModuleInitContext } from "@appstrate/core/module";
import { closeEeDb, openEeDb } from "./db.ts";
import { setPlatform } from "./platform.ts";
import { enterpriseSignInPlugin, refuseEnforcedSignup } from "./sso/auth-plugin.ts";
import {
  createSsoRouter,
  domainBodySchema,
  linkTenantBodySchema,
  settingsPatchSchema,
} from "./sso/routes.ts";
import { openApiComponentSchemas, openApiPaths, openApiTags } from "./sso/openapi.ts";
import { deleteOrganization } from "./sso/store.ts";

// `org-sso` as a module-owned RBAC resource: compile-time vocabulary here, runtime grants below.
declare module "@appstrate/core/permissions" {
  interface ModuleResources {
    "org-sso": "read" | "write";
  }
}

const eeModule: AppstrateModule = {
  manifest: { id: "enterprise", name: "Appstrate Enterprise", version: "0.1.0" },

  async init(ctx: ModuleInitContext) {
    // The tables live in the platform database; tier 0 (PGlite) has none to give.
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "@appstrate/ee requires PostgreSQL: set DATABASE_URL (its tables live in the platform database)",
      );
    }
    setPlatform(ctx);
    await openEeDb(databaseUrl);
  },

  betterAuthPlugins() {
    return [enterpriseSignInPlugin()];
  },

  createRouter() {
    return createSsoRouter();
  },

  openApiPaths,
  openApiTags,
  openApiComponentSchemas,

  openApiSchemas() {
    return [
      {
        method: "PATCH",
        path: "/api/org-sso",
        jsonSchema: z.toJSONSchema(settingsPatchSchema) as Record<string, unknown>,
        description: "Set the auto-join role",
      },
      {
        method: "POST",
        path: "/api/org-sso/tenant",
        jsonSchema: z.toJSONSchema(linkTenantBodySchema) as Record<string, unknown>,
        description: "Bind the tenant of the caller's own Microsoft sign-in",
      },
      {
        method: "POST",
        path: "/api/org-sso/domains",
        jsonSchema: z.toJSONSchema(domainBodySchema) as Record<string, unknown>,
        description: "Claim an email domain",
      },
    ];
  },

  features: { enterpriseSso: true },

  // Org-level and session-bound: never on an API key nor an end-user token.
  // Admins read; owners change (whoever sets the identity provider holds every
  // account of the domain, owners included).
  permissionsContribution: () => [
    { resource: "org-sso", actions: ["read"], level: "org", grantTo: ["owner", "admin"] },
    { resource: "org-sso", actions: ["write"], level: "org", grantTo: ["owner"] },
  ],

  hooks: {
    beforeSignup: refuseEnforcedSignup,
  },

  events: {
    onOrgDelete: (orgId: string) => deleteOrganization(orgId),
  },

  async shutdown() {
    await closeEeDb();
  },
};

export default eeModule;
