// SPDX-License-Identifier: Apache-2.0

/**
 * Wraps the external `@appstrate/cloud` package in the AppstrateModule contract.
 * Zero changes to the cloud/ repo — this adapter owns the dynamic import.
 */

import type { AppConfig } from "@appstrate/shared-types";
import type { AppstrateModule, ModuleInitContext } from "./types.ts";
import { SkipModuleError } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cloudMod: any = null;

export function createCloudModuleAdapter(): AppstrateModule {
  return {
    manifest: {
      id: "cloud",
      name: "Appstrate Cloud",
      version: "0.1.0",
    },

    async init(ctx: ModuleInitContext) {
      // Cloud requires external PostgreSQL — skip in PGlite mode
      if (ctx.isEmbeddedDb) {
        throw new SkipModuleError("Cloud requires external PostgreSQL");
      }

      // Dynamic import — if @appstrate/cloud is not installed, skip silently
      try {
        const pkg = "@appstrate/cloud";
        _cloudMod = await import(/* webpackIgnore: true */ pkg);
      } catch {
        throw new SkipModuleError("@appstrate/cloud not installed");
      }

      // Initialize cloud module with platform services
      const sendMail = await ctx.getSendMail();
      await _cloudMod.initCloud({
        databaseUrl: ctx.databaseUrl!,
        redisUrl: ctx.redisUrl ?? "",
        appUrl: ctx.appUrl,
        sendMail,
        getOrgAdminEmails: ctx.getOrgAdminEmails,
      });

      // Register email template overrides if provided
      if (_cloudMod.emailOverrides) {
        ctx.registerEmailOverrides(_cloudMod.emailOverrides);
      }

      // Wire domain allowlist hook into Better Auth signup
      if (_cloudMod.cloudHooks.onBeforeSignup) {
        ctx.setBeforeSignupHook(_cloudMod.cloudHooks.onBeforeSignup);
      }
    },

    publicPaths: ["/api/billing/webhooks"],

    registerRoutes(app) {
      _cloudMod.registerCloudRoutes(app);
    },

    extendAppConfig(base: AppConfig) {
      return {
        platform: "cloud" as const,
        features: { ...base.features, billing: true },
        legalUrls: _cloudMod.legalUrls,
      };
    },

    hooks: {
      checkQuota: (orgId: string, runningRunCount: number) =>
        _cloudMod.cloudHooks.checkQuota(orgId, runningRunCount),
      recordUsage: (orgId: string, runId: string, cost: number, context: { modelSource: string }) =>
        _cloudMod.cloudHooks.recordUsage(orgId, runId, cost, context),
      onOrgCreated: (orgId: string, userEmail: string) =>
        _cloudMod.cloudHooks.onOrgCreated(orgId, userEmail),
      onOrgDeleted: (orgId: string) => _cloudMod.cloudHooks.onOrgDeleted(orgId),
      getQuotaExceededError: () => _cloudMod.QuotaExceededError,
    },
  };
}
