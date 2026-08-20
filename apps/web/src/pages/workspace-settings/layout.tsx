// SPDX-License-Identifier: Apache-2.0

/**
 * Workspace settings.
 *
 * Its own surface rather than a section inside the organisation's, because a
 * workspace is its own SCOPE, not a subdivision of the org's configuration —
 * everything here is filtered by `X-Application-Id`. Nesting it produced the
 * oddity it replaces: an "Espace de travail" section holding a single entry,
 * next to a "Développeurs" section whose four screens were workspace-scoped
 * too.
 *
 * Reached from the gear on the workspace row of the org/workspace switcher; the
 * organisation's gear opens the other one.
 */
import { Navigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { KeyRound, LayoutGrid, Settings, Shield, Users, Webhook } from "lucide-react";
import { SettingsLayout, type SettingsSection } from "../../components/settings-layout";
import { usePermissions } from "../../hooks/use-permissions";
import { useAppConfig } from "../../hooks/use-app-config";
import { useCurrentApplicationId } from "../../hooks/use-current-application";
import { useApplication } from "../../hooks/use-applications";

export function WorkspaceSettingsLayout() {
  const { t } = useTranslation(["settings", "common"]);
  const { isAdmin } = usePermissions();
  const { features } = useAppConfig();
  const applicationId = useCurrentApplicationId();
  const { data: application } = useApplication(applicationId ?? "");

  const oidcEnabled = !!features.oidc;

  const sections: SettingsSection[] = [
    {
      label: t("workspaceSettings.sectionGeneral"),
      items: [
        { to: "/workspace-settings/general", icon: Settings, label: t("appSettings.tabGeneral") },
        {
          to: "/workspace-settings/auth",
          icon: Shield,
          label: t("appSettings.tabAuth"),
          show: oidcEnabled,
        },
      ],
    },
    {
      // How you plug Appstrate into your own systems. All four are scoped to
      // this workspace, which is why they sit here and not with the org.
      label: t("orgSettings.sectionDevelopers"),
      items: [
        {
          to: "/workspace-settings/api-keys",
          icon: KeyRound,
          label: t("orgSettings.tabApiKeys"),
        },
        {
          to: "/workspace-settings/oauth",
          icon: KeyRound,
          label: t("appSettings.tabOauth"),
          show: oidcEnabled,
        },
        { to: "/workspace-settings/end-users", icon: Users, label: t("endUsers.pageTitle") },
        {
          to: "/workspace-settings/webhooks",
          icon: Webhook,
          label: t("webhooks.pageTitle"),
          show: !!features.webhooks,
        },
      ],
    },
  ];

  const title = application?.name
    ? t("workspaceSettings.pageTitleNamed", { name: application.name })
    : t("workspaceSettings.pageTitle");

  // A real URL has to resolve to something: rendering nothing left a
  // non-admin staring at a blank page.
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <SettingsLayout
      title={title}
      scope={{
        icon: LayoutGrid,
        name: application?.name ?? "",
      }}
      sections={sections}
    />
  );
}
