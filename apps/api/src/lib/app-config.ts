import { getEnv } from "@appstrate/env";
import { getCloudModule } from "./cloud-loader.ts";
import type { AppConfig } from "@appstrate/shared-types";

const env = getEnv();

// Platform config — computed once at boot, injected into SPA HTML.
// In OSS (no cloud module): models & provider keys visible, billing hidden.
// In Cloud (@appstrate/cloud loaded): models & provider keys hidden (platform-managed), billing visible.
export function buildAppConfig(): AppConfig {
  const cloud = getCloudModule();
  const isCloud = cloud !== null;
  const cloudConfig = cloud?.getCloudConfig();
  return {
    platform: isCloud ? "cloud" : "oss",
    features: {
      billing: isCloud,
      models: !isCloud,
      providerKeys: !isCloud,
      googleAuth: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      githubAuth: !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      smtp: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM),
    },
    legalUrls: cloudConfig?.legalUrls,
    trustedOrigins: env.TRUSTED_ORIGINS,
  };
}

let _appConfig: AppConfig | null = null;

/** Returns the app config. Must be called after boot (cloud module loaded). */
export function getAppConfig(): AppConfig {
  if (!_appConfig) {
    _appConfig = buildAppConfig();
  }
  return _appConfig;
}
