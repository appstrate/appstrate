import { useTranslation } from "react-i18next";

export function ProviderConfigBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("settings");
  return enabled ? (
    <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 font-medium">
      {t("providers.configured")}
    </span>
  ) : (
    <span className="text-[0.65rem] px-1.5 py-0.5 rounded bg-warning/10 text-warning font-medium">
      {t("providers.notConfigured")}
    </span>
  );
}
