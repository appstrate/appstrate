// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Building } from "lucide-react";
import { McpClientConnect } from "../../components/org-settings/mcp-client-connect";
import { EmptyState } from "../../components/page-states";
import { SettingsGroup } from "../../components/settings/setting-row";
import { useOrg } from "../../hooks/use-org";

export function OrgSettingsMcpAccessPage() {
  const { t } = useTranslation("settings");
  const { currentOrg } = useOrg();

  if (!currentOrg) {
    return <EmptyState message={t("orgSettings.noOrg")} icon={Building} />;
  }

  return (
    <SettingsGroup title={t("orgSettings.mcpTitle")}>
      <div className="border-border border-b py-4">
        <p className="text-muted-foreground mb-4 text-sm">{t("orgSettings.mcpDesc")}</p>
        <McpClientConnect
          serverName={`appstrate-${currentOrg.slug}`}
          url={`${window.location.origin}/api/mcp/o/${currentOrg.id}`}
        />
      </div>
    </SettingsGroup>
  );
}
