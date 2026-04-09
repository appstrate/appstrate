// SPDX-License-Identifier: Apache-2.0

/**
 * Module registry — declares which modules are available and provides
 * the platform-level init context injected into each module.
 */

import { isEmbeddedDb } from "@appstrate/db/client";
import { registerEmailOverrides } from "@appstrate/emails";
import { setBeforeSignupHook } from "@appstrate/db/auth";
import { db } from "@appstrate/db/client";
import { organizationMembers, user } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { ModuleEntry, ModuleInitContext } from "./types.ts";
import { createCloudModuleAdapter } from "./cloud-adapter.ts";

// ---------------------------------------------------------------------------
// Registry — one entry per available module
// ---------------------------------------------------------------------------

/**
 * Returns the list of module entries to load at boot.
 * Add new modules here. The cloud adapter owns its own dynamic import
 * internally — if @appstrate/cloud is not installed, it throws
 * SkipModuleError and is silently skipped.
 */
export function getModuleRegistry(): ModuleEntry[] {
  return [
    { module: createCloudModuleAdapter() },
    // Future modules:
    // { module: createOidcModule() },
    // { module: createExampleModule(), required: false },
  ];
}

// ---------------------------------------------------------------------------
// Init context builder
// ---------------------------------------------------------------------------

export function buildModuleInitContext(): ModuleInitContext {
  const env = process.env;
  return {
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? null,
    appUrl: env.APP_URL ?? "http://localhost:3000",
    isEmbeddedDb,
    getSendMail: async () => {
      // Lazy import to break circular dep: email.ts -> app-config.ts -> modules
      const { sendMail } = await import("../../services/email.ts");
      return sendMail;
    },
    getOrgAdminEmails,
    registerEmailOverrides,
    setBeforeSignupHook,
  };
}

// ---------------------------------------------------------------------------
// DI: org admin emails query (moved from cloud-loader.ts)
// ---------------------------------------------------------------------------

async function getOrgAdminEmails(orgId: string): Promise<string[]> {
  const admins = await db
    .select({ email: user.email })
    .from(organizationMembers)
    .innerJoin(user, eq(organizationMembers.userId, user.id))
    .where(
      and(
        eq(organizationMembers.orgId, orgId),
        inArray(organizationMembers.role, ["admin", "owner"]),
      ),
    );

  return admins.map((a) => a.email);
}
