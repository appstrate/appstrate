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
import type { ModuleInitContext, PlatformServices } from "@appstrate/core/module";
import { getEnv } from "@appstrate/env";
import { applyModuleMigrations } from "./migrate.ts";

// ---- Platform service imports (for buildPlatformServices) -----------------
import { logger } from "../logger.ts";
import { loadModel, listOrgModels } from "../../services/org-models.ts";
import { getPackage } from "../../services/agent-service.ts";
import { isInlineShadowPackageId } from "../../services/inline-run.ts";
import { runInlinePreflight } from "../../services/inline-run-preflight.ts";
import { getDefaultApplication } from "../../services/applications.ts";
import { listAllActorConnections } from "../../services/connection-manager/providers.ts";
import { appendRunLog, updateRun } from "../../services/state/runs.ts";
import { abortRun } from "../../services/run-tracker.ts";
import { addSubscriber, removeSubscriber } from "../../services/realtime.ts";
import { getOrchestrator } from "../../services/orchestrator/index.ts";
import { getPubSub } from "../../infra/index.ts";
import { hasRedis, hasExternalDb } from "../../infra/mode.ts";
import { getModule, emitEvent } from "./module-loader.ts";

// ---------------------------------------------------------------------------
// Registry — env-driven module specifiers
// ---------------------------------------------------------------------------
//
// Each specifier in MODULES is resolved at boot by `loadModules`:
// a matching `apps/api/src/modules/<specifier>/index.ts` directory is loaded
// as a built-in, otherwise the specifier is treated as an npm package name
// and resolved via dynamic import.
// ---------------------------------------------------------------------------

/**
 * Returns the list of module entries to load at boot.
 *
 * Reads `MODULES` (comma-separated specifiers) directly from
 * `process.env` rather than the cached `getEnv()`, so callers can mutate
 * the env in tests without flushing the whole env cache. The field is a
 * plain comma-separated string — no validation beyond trim/filter is useful.
 *
 * Defaults to the built-in OSS modules (`oidc,webhooks`) when the env
 * var is unset. External deployments extend the list by appending npm
 * package specifiers, e.g.:
 *   MODULES=oidc,webhooks,@scope/module
 *
 * All declared modules are required — if a module is in the list, it must
 * load and init successfully or the platform crashes.
 */
const DEFAULT_MODULES = "oidc,webhooks";

export function getModuleRegistry(): string[] {
  return (process.env.MODULES ?? DEFAULT_MODULES)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Init context builder
// ---------------------------------------------------------------------------

/**
 * Wire concrete platform services into the structural `PlatformServices`
 * contract declared in `@appstrate/core/module`.
 *
 * The `as PlatformServices[…]` casts are deliberate: concrete apps/api
 * functions have narrower types (e.g. `load(): Promise<ResolvedModel | null>`)
 * than the loose structural interface (`load(): Promise<unknown>`). This is
 * safe by construction — the loose type is a supertype of the concrete one —
 * but TypeScript cannot infer the relationship across the package boundary.
 */
function buildPlatformServices(): PlatformServices {
  return {
    logger,
    orchestrator: { get: getOrchestrator },
    pubsub: { get: getPubSub },
    env: { hasRedis, hasExternalDb },
    models: { load: loadModel, listForOrg: listOrgModels },
    packages: {
      get: getPackage as PlatformServices["packages"]["get"],
      isInlineShadow: isInlineShadowPackageId,
    },
    applications: { getDefault: getDefaultApplication },
    connections: {
      listAllForActor:
        listAllActorConnections as unknown as PlatformServices["connections"]["listAllForActor"],
    },
    runs: {
      appendLog: appendRunLog as unknown as PlatformServices["runs"]["appendLog"],
      update: updateRun as unknown as PlatformServices["runs"]["update"],
      abort: abortRun,
    },
    inline: { trigger: runInlinePreflight as PlatformServices["inline"]["trigger"] },
    realtime: { addSubscriber, removeSubscriber },
    modules: { get: getModule, emit: emitEvent as PlatformServices["modules"]["emit"] },
  };
}

export function buildModuleInitContext(): ModuleInitContext {
  const env = getEnv();
  const ctx: ModuleInitContext = {
    databaseUrl: env.DATABASE_URL ?? null,
    redisUrl: env.REDIS_URL ?? null,
    appUrl: env.APP_URL,
    isEmbeddedDb,
    applyMigrations: (moduleId, migrationsDir, opts) =>
      applyModuleMigrations(moduleId, migrationsDir, opts),
    getSendMail: async () => {
      // Lazy import to break circular dep: email.ts -> app-config.ts -> modules
      const { sendMail } = await import("../../services/email.ts");
      return sendMail;
    },
    getOrgAdminEmails,
    services: buildPlatformServices(),
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
