// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { User, Palette, Shield, Plug, Laptop } from "lucide-react";
import { SettingsLayout } from "../../components/settings-layout";
import { useAuth } from "../../hooks/use-auth";

export function PreferencesLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const { user, profile } = useAuth();

  return (
    <SettingsLayout
      title={t("preferences.title")}
      scope={{
        icon: User,
        name: profile?.displayName || user?.name || user?.email || "",
      }}
      sections={[
        {
          label: t("preferences.sectionAccount"),
          items: [
            { to: "/preferences/general", icon: User, label: t("preferences.tabGeneral") },
            {
              to: "/preferences/appearance",
              icon: Palette,
              label: t("preferences.tabAppearance"),
            },
            { to: "/preferences/security", icon: Shield, label: t("preferences.tabSecurity") },
            {
              to: "/preferences/devices",
              icon: Laptop,
              label: t("preferences.tabDevices"),
            },
            {
              to: "/preferences/connections",
              icon: Plug,
              label: t("preferences.tabConnections"),
            },
          ],
        },
      ]}
    />
  );
}
