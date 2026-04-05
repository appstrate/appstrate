// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

interface ProviderConfigBadgeProps {
  enabled: boolean;
  /** App-level override info (only shown when in a custom app) */
  appOverride?: {
    hasAppCredentials: boolean;
    appEnabled: boolean;
  };
}

export function ProviderConfigBadge({ enabled, appOverride }: ProviderConfigBadgeProps) {
  const { t } = useTranslation("settings");

  // App-level disabled overrides everything
  if (appOverride && !appOverride.appEnabled) {
    return (
      <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-red-500">
        {t("providers.disabledForApp")}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {enabled ? (
        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-emerald-500">
          {t("providers.configured")}
        </span>
      ) : (
        <span className="bg-warning/10 text-warning rounded px-1.5 py-0.5 text-[0.65rem] font-medium">
          {t("providers.notConfigured")}
        </span>
      )}
      {appOverride?.hasAppCredentials && (
        <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-blue-500">
          {t("providers.appOverride")}
        </span>
      )}
    </div>
  );
}
