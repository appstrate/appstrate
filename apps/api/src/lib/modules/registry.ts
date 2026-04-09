// SPDX-License-Identifier: Apache-2.0

/**
 * Module registry — declares which modules are available and provides
 * the platform-level init context injected into each module.
 *
 * The registry is AGNOSTIC — it only knows package specifiers, never
 * module internals. Each module is a dynamic import that must export
 * a default AppstrateModule (or an `appstrateModule` named export).
 */

import { isEmbeddedDb } from "@appstrate/db/client";
import { registerEmailOverrides } from "@appstrate/emails";
import { setBeforeSignupHook } from "@appstrate/db/auth";
import { db } from "@appstrate/db/client";
import { organizationMembers, user } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { ModuleEntry, ModuleInitContext } from "@appstrate/core/module";

// ---------------------------------------------------------------------------
// Registry — one entry per available module
// ---------------------------------------------------------------------------

/**
 * Returns the list of module entries to load at boot.
 *
 * Each entry is a dynamic import specifier. The module loader resolves
 * the import at runtime — if the package is not installed, it is silently
 * skipped (unless `required: true`).
 *
 * The platform NEVER references module internals here — it only knows
 * the npm package name. The module itself implements AppstrateModule.
 */
export function getModuleRegistry(): ModuleEntry[] {
  return [
    { specifier: "@appstrate/cloud" },
    // Future modules:
    // { specifier: "@appstrate/oidc" },
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
// DI: org admin emails query
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
