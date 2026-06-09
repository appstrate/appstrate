// SPDX-License-Identifier: Apache-2.0

/**
 * Module registry — declares which modules are available and provides
 * the platform-level init context injected into each module.
 *
 * The registry is AGNOSTIC — it only knows package specifiers, never
 * module internals. Each module is a dynamic import that must export
 * a default AppstrateModule (or an `appstrateModule` named export).
 */

import { db } from "@appstrate/db/client";
import { organizationMembers, user } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { ModuleInitContext, PlatformServices } from "@appstrate/core/module";
import { getEnv } from "@appstrate/env";

// ---- Platform service imports (for buildPlatformServices) -----------------
import { logger } from "../logger.ts";
import { listLlmUsageForRun } from "../../services/state/runs.ts";

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
 * Defaults to the built-in OSS modules plus the two reference
 * OAuth-provider modules (`@appstrate/module-codex`,
 * `@appstrate/module-claude-code`) when the env var is unset. External
 * deployments extend the list by appending npm package specifiers, e.g.:
 *   MODULES=oidc,webhooks,mcp,core-providers,@appstrate/module-codex,@appstrate/module-claude-code,@scope/module
 *
 * `core-providers` ships the API-key model providers (openai, anthropic,
 * openai-compatible) as an explicit, disablable module so cloud SaaS
 * deployments that BYO their own provider catalog can opt out cleanly.
 *
 * `@appstrate/module-codex` (ChatGPT/Codex OAuth) and
 * `@appstrate/module-claude-code` (Claude Pro/Max/Team OAuth) ship as
 * the two reference external-provider modules. They are enabled by
 * default; operators who do not want to expose ChatGPT- or
 * Claude-subscription billing must remove them from `MODULES`
 * explicitly (cf. upstream ToS posture for each — OpenAI Consumer ToU
 * grey zone, Anthropic Consumer ToS forbids third-party use of OAuth
 * subscription tokens).
 *
 * All declared modules are required — if a module is in the list, it must
 * load and init successfully or the platform crashes.
 */
const DEFAULT_MODULES =
  "oidc,webhooks,mcp,core-providers,@appstrate/module-codex,@appstrate/module-claude-code";

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
 * contract declared in `@appstrate/core/module`. The surface is intentionally
 * minimal — only `runs.listLlmUsage` (the cloud billing module's per-run
 * ledger read) is exposed. See the `PlatformServices` doc in core for the
 * razor and the history of the previous (chat-era) broad surface.
 */
function buildPlatformServices(): PlatformServices {
  return {
    logger,
    runs: { listLlmUsage: listLlmUsageForRun },
  };
}

export function buildModuleInitContext(): ModuleInitContext {
  const env = getEnv();
  const ctx: ModuleInitContext = {
    redisUrl: env.REDIS_URL ?? null,
    appUrl: env.APP_URL,
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
