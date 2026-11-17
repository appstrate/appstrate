// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { OptionSelect } from "@/components/app-ui/option-select";
import { useTheme } from "../../stores/theme-store";
import { useUpdateLanguage } from "../../hooks/use-profile";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";
import { SaveFeedback } from "../../components/settings/save-feedback";

export function PreferencesAppearancePage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { theme, setTheme } = useTheme();
  const updateLanguage = useUpdateLanguage();

  return (
    <SettingsGroup title={t("preferences.interface")}>
      <SettingRow variant="field" label={t("common:userMenu.theme")}>
        {(labelId) => (
          <OptionSelect
            value={theme}
            onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}
            aria-labelledby={labelId}
            options={[
              { value: "light", label: t("common:userMenu.themeLight") },
              { value: "dark", label: t("common:userMenu.themeDark") },
              { value: "system", label: t("common:userMenu.themeSystem") },
            ]}
          />
        )}
      </SettingRow>

      <SettingRow
        variant="field"
        label={t("preferences.language")}
        status={
          <SaveFeedback
            pending={updateLanguage.isPending}
            success={updateLanguage.isSuccess}
            error={updateLanguage.isError}
          />
        }
      >
        {(labelId) => (
          <OptionSelect
            value={i18n.language}
            onValueChange={(lng) =>
              updateLanguage.mutate({ body: { language: lng as "fr" | "en" } })
            }
            disabled={updateLanguage.isPending}
            aria-labelledby={labelId}
            options={[
              { value: "fr", label: t("preferences.langFr") },
              { value: "en", label: t("preferences.langEn") },
            ]}
          />
        )}
      </SettingRow>
    </SettingsGroup>
  );
}
