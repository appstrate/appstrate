// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ArrowUpCircle } from "lucide-react";
import { useUpdateCheck } from "../hooks/use-update-check";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@appstrate/ui/components/sidebar";

/**
 * "Update available" badge (#694) — shown in the sidebar footer when the
 * platform is behind the latest published release. Notification only: it
 * links to the self-hosting upgrade guide, the upgrade itself is a host-side
 * operation (`docker compose pull && docker compose up -d`). Renders nothing
 * when up to date, when the check is disabled (`UPDATE_CHECK_ENABLED=false`),
 * or on source/dev runs.
 */
const UPGRADE_GUIDE_URL =
  "https://github.com/appstrate/appstrate/blob/main/examples/self-hosting/README.md#upgrading";

export function UpdateBadge() {
  const { t } = useTranslation();
  const { data } = useUpdateCheck();

  const update = data?.update;
  if (!update?.update_available || !update.latest_version) return null;

  const label = t("nav.updateAvailable", { version: `v${update.latest_version}` });

  return (
    <SidebarGroup className="py-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip={t("nav.updateAvailableTooltip")}
            className="text-primary hover:text-primary"
          >
            <a href={UPGRADE_GUIDE_URL} target="_blank" rel="noreferrer" title={label}>
              <ArrowUpCircle size={16} />
              <span className="truncate">{label}</span>
            </a>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
