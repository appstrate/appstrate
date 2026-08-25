// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { useTheme } from "../../stores/theme-store";
import { useUpdateLanguage } from "../../hooks/use-profile";
import { SettingsGroup, SettingRow } from "../../components/settings/setting-row";

export function PreferencesAppearancePage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { theme, setTheme } = useTheme();
  const updateLanguage = useUpdateLanguage();

  return (
    <SettingsGroup title={t("preferences.interface")}>
      <SettingRow variant="field" label={t("preferences.theme")}>
        <Select value={theme} onValueChange={(v) => setTheme(v as "light" | "dark" | "system")}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="light">{t("preferences.themeLight")}</SelectItem>
            <SelectItem value="dark">{t("preferences.themeDark")}</SelectItem>
            <SelectItem value="system">{t("preferences.themeSystem")}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      <SettingRow variant="field" label={t("preferences.language")}>
        <Select
          value={i18n.language}
          onValueChange={(lng) => updateLanguage.mutate({ body: { language: lng as "fr" | "en" } })}
          disabled={updateLanguage.isPending}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fr">{t("preferences.langFr")}</SelectItem>
            <SelectItem value="en">{t("preferences.langEn")}</SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>
    </SettingsGroup>
  );
}
