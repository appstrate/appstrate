// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "../../stores/theme-store";
import { useUpdateLanguage } from "../../hooks/use-profile";

export function PreferencesAppearancePage() {
  const { t, i18n } = useTranslation(["settings", "common"]);
  const { theme, setTheme } = useTheme();
  const updateLanguage = useUpdateLanguage();

  return (
    <>
      <div className="text-muted-foreground mb-4 text-sm font-medium">{t("preferences.theme")}</div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
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
          </div>
        </div>
      </div>

      <div className="text-muted-foreground mb-4 text-sm font-medium">
        {t("preferences.language")}
      </div>
      <div className="border-border bg-card mb-4 rounded-lg border p-5">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <Select
              value={i18n.language}
              onValueChange={(lng) => updateLanguage.mutate(lng)}
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
          </div>
        </div>
      </div>
    </>
  );
}
