// SPDX-License-Identifier: Apache-2.0

import type { AppConfig } from "@appstrate/shared-types";

declare global {
  interface Window {
    __APP_CONFIG__: AppConfig;
  }
}

const DEFAULT_CONFIG: AppConfig = {
  features: {
    googleAuth: false,
    githubAuth: false,
    smtp: false,
  },
  trustedOrigins: [],
};

export type { AppConfig };

export function useAppConfig(): AppConfig {
  return window.__APP_CONFIG__ ?? DEFAULT_CONFIG;
}
