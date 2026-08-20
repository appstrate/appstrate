// SPDX-License-Identifier: Apache-2.0

/**
 * The sidebar's meta block: what is ABOUT the workspace, not what you do in it.
 *
 * Set apart from the navigation above, and rendered smaller and quieter, for a
 * reason rather than for looks: Usage and Settings are consulted occasionally
 * and never in a working loop, so giving them the same weight as Agents or Runs
 * would misprice them. Same reason Settings left the "Administration" group,
 * where it sat next to End-Users as if the two were the same kind of errand.
 */
import { Link, useLocation } from "react-router-dom";
import { openAsModal } from "../lib/modal-route";
import { useTranslation } from "react-i18next";
import { BarChart3, Settings } from "lucide-react";
import { useAppConfig } from "../hooks/use-app-config";
import { usePermissions } from "../hooks/use-permissions";
import { cn } from "@appstrate/ui/cn";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";

export function SidebarMeta() {
  const { t } = useTranslation();
  const location = useLocation();
  const { pathname } = location;
  const { features } = useAppConfig();
  const { isAdmin } = usePermissions();

  const items = [
    // No billing configured means no usage to read — the row would open an
    // empty page.
    ...(features.billing
      ? [
          {
            path: "/org-settings/billing",
            label: t("nav.usage"),
            icon: BarChart3,
            active: pathname.startsWith("/org-settings/billing"),
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            path: "/org-settings",
            label: t("nav.settings"),
            icon: Settings,
            active: pathname.startsWith("/org-settings"),
          },
        ]
      : []),
  ];

  if (items.length === 0) return null;

  return (
    <SidebarGroup className="py-1">
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.path}>
            <SidebarMenuButton
              asChild
              size="sm"
              tooltip={item.label}
              isActive={item.active}
              className="text-muted-foreground hover:text-sidebar-foreground"
            >
              <Link to={item.path} state={openAsModal(location)}>
                <item.icon className={cn("size-4 shrink-0")} />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
