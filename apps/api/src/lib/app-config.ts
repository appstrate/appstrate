// SPDX-License-Identifier: Apache-2.0

import { getEnv } from "@appstrate/env";
import { applyModuleAppConfig } from "./modules/index.ts";
import type { AppConfig } from "@appstrate/shared-types";

const env = getEnv();

// Platform config — computed once at boot, injected into SPA HTML.
// Base config uses OSS defaults. Modules extend it via `extendAppConfig()`.
export function buildAppConfig(): AppConfig {
  return {
    platform: "oss",
    features: {
      billing: false,
      models: true,
      providerKeys: true,
      googleAuth: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      githubAuth: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      smtp: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM),
    },
    trustedOrigins: env.TRUSTED_ORIGINS,
  };
}

let _appConfig: AppConfig | null = null;

/** Returns the app config. Must be called after boot (modules loaded). */
export function getAppConfig(): AppConfig {
  if (!_appConfig) {
    _appConfig = applyModuleAppConfig(buildAppConfig());
  }
  return _appConfig;
}
