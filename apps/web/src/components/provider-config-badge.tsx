// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";

export function ProviderConfigBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("settings");
  return enabled ? (
    <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[0.65rem] font-medium text-emerald-500">
      {t("providers.configured")}
    </span>
  ) : (
    <span className="bg-warning/10 text-warning rounded px-1.5 py-0.5 text-[0.65rem] font-medium">
      {t("providers.notConfigured")}
    </span>
  );
}
