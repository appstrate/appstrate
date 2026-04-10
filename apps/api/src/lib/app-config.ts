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
      billing: false,
      models: false,
      providerKeys: false,
      webhooks: false,
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

/** Returns the app config. Must be called after boot (modules loaded). */
export function getAppConfig(): AppConfig {
  if (!_appConfig) {
    _appConfig = applyModuleFeatures(buildAppConfig());
  }
  return _appConfig;
}
