// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { User, Palette, Shield, Plug, UserCircle, Laptop } from "lucide-react";
import { SettingsLayout } from "../../components/settings-layout";

export function PreferencesLayout() {
  const { t } = useTranslation(["settings", "common"]);

  return (
    <SettingsLayout
      title={t("preferences.title")}
      emoji="👤"
      breadcrumbs={[
        { label: t("nav.orgSection", { ns: "common" }), href: "/" },
        { label: t("preferences.title") },
      ]}
      sections={[
        {
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
              to: "/preferences/connectors",
              icon: Plug,
              label: t("preferences.tabConnectors"),
            },
            {
              to: "/preferences/profiles",
              icon: UserCircle,
              label: t("preferences.tabProfiles"),
            },
          ],
        },
      ]}
    />
  );
}
