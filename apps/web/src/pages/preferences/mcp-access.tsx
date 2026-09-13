// SPDX-License-Identifier: Apache-2.0

/**
 * Connecting one's own MCP client, which is a personal setting.
 *
 * It sat in the organisation's settings and was the only entry there with no
 * permission gate — so a guest, who can change nothing in the organisation,
 * still saw a Settings menu holding this one page. Nothing here is
 * administration: the URL is public to the org's members, the shortcuts
 * configure a client on this person's machine, and what that client may then
 * do is decided by their own permissions, server-side. It belongs beside the
 * CLI sessions in the profile.
 */

import { useTranslation } from "react-i18next";
import { Building } from "lucide-react";
import { McpClientConnect } from "../../components/org-settings/mcp-client-connect";
import { EmptyState } from "../../components/page-states";
import { SettingsGroup } from "../../components/settings/setting-row";
import { useOrg } from "../../hooks/use-org";

export function PreferencesMcpAccessPage() {
  const { t } = useTranslation("settings");
  const { currentOrg } = useOrg();

  if (!currentOrg) {
    return <EmptyState message={t("orgSettings.noOrg")} icon={Building} />;
  }

  return (
    <SettingsGroup title={t("orgSettings.mcpTitle")}>
      <div className="pb-8">
        <p className="text-muted-foreground mb-4 text-sm">{t("orgSettings.mcpDesc")}</p>
        <McpClientConnect
          serverName={`appstrate-${currentOrg.slug}`}
          url={`${window.location.origin}/api/mcp/o/${currentOrg.id}`}
        />
      </div>
    </SettingsGroup>
  );
}
