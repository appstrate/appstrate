// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { applyModuleFeatures } from "./modules/module-loader.ts";
import type { AppConfig } from "@appstrate/shared-types";

const env = getEnv();

// Platform config — computed once at boot, injected into SPA HTML.
// Base config uses OSS defaults. Modules contribute feature flags at boot.
export function buildAppConfig(): AppConfig {
  const legalTerms = env.LEGAL_TERMS_URL;
  const legalPrivacy = env.LEGAL_PRIVACY_URL;
  return {
    features: {
      // Core platform flags only — derived from env vars owned by core.
      // Module-owned flags (webhooks, oidc, …) are merged in by
      // `applyModuleFeatures()` after load.
      googleAuth: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      githubAuth: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      smtp: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM),
    },
    ...(legalTerms && legalPrivacy
      ? {
          legalUrls: {
            terms: legalTerms,
            privacy: legalPrivacy,
          },
        }
      : {}),
    trustedOrigins: env.TRUSTED_ORIGINS,
  };
}

let _appConfig: AppConfig | null = null;

/** Initialize the app config. Must be called once during boot (after modules loaded). */
export async function initAppConfig(): Promise<void> {
  _appConfig = await applyModuleFeatures(buildAppConfig());
}

/** Returns the app config. Must be called after `initAppConfig()`. */
export function getAppConfig(): AppConfig {
  if (!_appConfig) {
    throw new Error("getAppConfig() called before initAppConfig() — check boot order");
  }
  return _appConfig;
}
