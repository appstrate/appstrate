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
import { organizationMembers, organizations, user } from "@appstrate/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { ModuleInitContext, PlatformServices } from "@appstrate/core/module";
import { getEnv } from "@appstrate/env";

// ---- Platform service imports (for buildPlatformServices) -----------------
import { logger } from "../logger.ts";
import { rateLimit } from "../../middleware/rate-limit.ts";
import { getClientIp } from "../client-ip.ts";
import { listLlmUsage, getSettledFrontierId } from "../../services/state/runs.ts";
import { dispatchInProcess } from "../platform-app.ts";
import {
  recordChatUsage,
  resolveSubscriptionChatModel,
  checkUsageAllowed,
} from "../../services/chat-subscription.ts";

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
 * Reads `MODULES` (comma-separated specifiers) via `getEnv()` so the
 * default string lives in exactly one place — the `@appstrate/env` Zod
 * schema (duplicating it here is the #513 drift failure mode). Tests that
 * mutate `process.env.MODULES` must call `_resetCacheForTesting()` from
 * `@appstrate/env` to flush the cached snapshot.
 *
 * Defaults to the built-in OSS modules ONLY
 * (`oidc,webhooks,mcp,core-providers,@appstrate/module-chat`) — the authoritative default lives
 * in the `@appstrate/env` Zod schema (`packages/env/src/index.ts`).
 * External deployments extend the list by appending specifiers, e.g.:
 *   MODULES=oidc,webhooks,mcp,core-providers,@appstrate/module-chat,@appstrate/module-codex,@appstrate/module-claude-code,@scope/module
 *
 * `core-providers` ships the API-key model providers (openai, anthropic,
 * openai-compatible) as an explicit, disablable module so cloud SaaS
 * deployments that BYO their own provider catalog can opt out cleanly.
 *
 * `@appstrate/module-codex` (ChatGPT/Codex OAuth) and
 * `@appstrate/module-claude-code` (Claude Pro/Max/Team OAuth) are the two
 * reference subscription-provider modules. They are OPT-IN — NOT in the
 * default set — because each sits in a vendor-ToS grey zone (OpenAI
 * Consumer ToU grey zone; Anthropic Consumer ToS forbids third-party use
 * of OAuth subscription tokens). An operator enables them deliberately by
 * appending them to `MODULES` (cf. `docs/architecture/SUBSCRIPTION_COMPLIANCE.md`).
 *
 * All declared modules are required — if a module is in the list, it must
 * load and init successfully or the platform crashes.
 *
 * Booting with ZERO modules: `MODULES=none` is the documented sentinel.
 * Note `MODULES=""` (present but empty) resolves to the DEFAULT set, not
 * zero — the env getter coalesces `""` → unset by design (compose
 * `${VAR:-}` pattern), so an explicit sentinel is the only way to say
 * "no modules".
 */
export function getModuleRegistry(): string[] {
  const value = getEnv().MODULES;
  if (value.trim() === "none") return [];
  return value
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
 * minimal — `usage.list` / `usage.settledFrontier` (the cloud metering module's cursor
 * sweep of the `llm_usage` ledger), `inProcess.dispatch`, and the chat seam
 * (`resolveSubscriptionChatModel` + `recordChatUsage` + `checkUsageAllowed`) by
 * which the chat module drives the single generic in-process Pi chat engine,
 * meters it, and gates admission — the module resolves credentials/tokens,
 * records usage, and gates through here because it has no DB access. See the
 * `PlatformServices` doc in core for the razor.
 */
function buildPlatformServices(): PlatformServices {
  return {
    logger,
    http: {
      // Same authenticated limiter every core route uses — modules get
      // identical guard semantics (keying, headers, 429 shape).
      rateLimit: (maxPerMinute) => rateLimit(maxPerMinute) as MiddlewareHandler,
      // Same TRUST_PROXY-honoring resolver every core route uses — modules
      // that tag telemetry or key rate buckets by IP get identical semantics.
      clientIp: getClientIp,
    },
    usage: {
      list: listLlmUsage,
      settledFrontier: getSettledFrontierId,
    },
    inProcess: {
      // In-process self-dispatch through the full platform middleware chain.
      dispatch: dispatchInProcess,
    },
    // Chat seam — the chat module resolves a subscription model's real binding +
    // fresh token (credential resolution stays server-side), meters each turn,
    // and gates non-subscription admission through these, since it has no DB
    // access.
    resolveSubscriptionChatModel,
    recordChatUsage,
    checkUsageAllowed,
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
    getOrgName,
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

// ---------------------------------------------------------------------------
// DI: org display-name query
// ---------------------------------------------------------------------------

async function getOrgName(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return row?.name ?? null;
}
