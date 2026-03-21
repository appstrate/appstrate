import type { AppConfig } from "@appstrate/shared-types";

declare global {
  interface Window {
    __APP_CONFIG__: AppConfig;
  }
}

const DEFAULT_CONFIG: AppConfig = {
  platform: "oss",
  features: { billing: false, models: true, providerKeys: true },
};

export type { AppConfig };

export function useAppConfig(): AppConfig {
  return window.__APP_CONFIG__ ?? DEFAULT_CONFIG;
}
