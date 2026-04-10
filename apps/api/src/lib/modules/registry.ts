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
import { applyModuleMigrations } from "./migrate.ts";

// ---------------------------------------------------------------------------
// Registry — env-driven module specifiers
// ---------------------------------------------------------------------------
//
// Each specifier in APPSTRATE_MODULES is resolved at boot by `loadModules`:
// a matching `apps/api/src/modules/<specifier>/index.ts` directory is loaded
// as a built-in, otherwise the specifier is treated as an npm package name
// and resolved via dynamic import.
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
  const ctx: ModuleInitContext = {
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? null,
    appUrl: env.APP_URL ?? "http://localhost:3000",
    isEmbeddedDb,
    applyMigrations: (moduleId, migrationsDir) =>
      applyModuleMigrations(ctx, moduleId, migrationsDir),
    getSendMail: async () => {
      // Lazy import to break circular dep: email.ts -> app-config.ts -> modules
      const { sendMail } = await import("../../services/email.ts");
      return sendMail;
    },
    getOrgAdminEmails,
  };
  return ctx;
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
