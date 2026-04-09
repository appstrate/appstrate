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
import { db } from "@appstrate/db/client";
import { organizationMembers, user } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { ModuleInitContext } from "@appstrate/core/module";
import { registerBuiltinModule } from "./module-loader.ts";

// ---------------------------------------------------------------------------
// Built-in platform modules (loaded only if listed in APPSTRATE_MODULES)
// ---------------------------------------------------------------------------

registerBuiltinModule("scheduling", () => import("../../modules/scheduling/index.ts"));
registerBuiltinModule("webhooks", () => import("../../modules/webhooks/index.ts"));
registerBuiltinModule(
  "provider-management",
  () => import("../../modules/provider-management/index.ts"),
);

// ---------------------------------------------------------------------------
// Registry — env-driven module specifiers
// ---------------------------------------------------------------------------

/**
 * Returns the list of module entries to load at boot.
 *
 * Reads from the APPSTRATE_MODULES env var (comma-separated specifiers).
 * Empty by default (OSS mode). Cloud deployments set:
 *   APPSTRATE_MODULES=@appstrate/cloud
 *
 * All declared modules are required — if a module is in the list, it must
 * load and init successfully or the platform crashes.
 */
export function getModuleRegistry(): string[] {
  const raw = process.env.APPSTRATE_MODULES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
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
