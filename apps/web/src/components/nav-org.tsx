// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Layers,
  Activity,
  Calendar,
  Wrench,
  Puzzle,
  Plug,
  Settings,
  Webhook,
  Loader2,
} from "lucide-react";
import { useUnreadCount } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { usePermissions } from "../hooks/use-permissions";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function NavOrg() {
  const { t } = useTranslation();
  const location = useLocation();
  const { data: unreadCount } = useUnreadCount();
  const { data: agents } = useAgents();
  const { isAdmin } = usePermissions();

  const hasRunning = agents?.some((f) => f.runningRuns > 0) ?? false;
  const unread = unreadCount ?? 0;

  const automationItems = [
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    { path: "/agents", label: t("nav.flows"), icon: Layers },
    { path: "/schedules", label: t("nav.schedules"), icon: Calendar },
  ];

  const resourceItems = [
    { path: "/skills", label: t("nav.skills"), icon: Wrench },
    { path: "/tools", label: t("nav.tools"), icon: Puzzle },
  ];

  const renderItems = (items: typeof automationItems) =>
    items.map((item) => (
      <SidebarMenuItem key={item.path}>
        <SidebarMenuButton
          asChild
          isActive={
            item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path)
          }
          tooltip={item.label}
        >
          <Link to={item.path}>
            <item.icon />
            <span>{item.label}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ));

  return (
    <>
      {/* Automatisation */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("nav.automationSection")}</SidebarGroupLabel>
        <SidebarMenu>
          {renderItems(automationItems)}
          {/* Executions — with unread badge + running indicator */}
          <SidebarMenuItem className="relative">
            <SidebarMenuButton
              asChild
              isActive={location.pathname.startsWith("/runs")}
              tooltip={t("nav.runs")}
            >
              <Link to="/runs">
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {hasRunning ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Activity size={16} />
                  )}
                </span>
                <span>{t("nav.runs")}</span>
              </Link>
            </SidebarMenuButton>
            {unread > 0 && (
              <>
                <SidebarMenuBadge>
                  <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
                    {unread > 99 ? "99+" : unread}
                  </span>
                </SidebarMenuBadge>
                <span className="ring-sidebar bg-destructive pointer-events-none absolute top-1 right-1 hidden size-2 rounded-full ring-2 group-data-[collapsible=icon]:block" />
              </>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>

      {/* Ressources */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("nav.resourcesSection")}</SidebarGroupLabel>
        <SidebarMenu>{renderItems(resourceItems)}</SidebarMenu>
      </SidebarGroup>

      {/* Intégrations */}
      <SidebarGroup>
        <SidebarGroupLabel>{t("nav.integrationsSection")}</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={location.pathname.startsWith("/providers")}
              tooltip={t("nav.connectors")}
            >
              <Link to="/providers">
                <Plug />
                <span>{t("nav.connectors")}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={location.pathname.startsWith("/webhooks")}
                tooltip={t("nav.webhooks")}
              >
                <Link to="/webhooks">
                  <Webhook />
                  <span>{t("nav.webhooks")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {isAdmin && (
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={location.pathname.startsWith("/org-settings")}
                tooltip={t("nav.settings")}
              >
                <Link to="/org-settings">
                  <Settings />
                  <span>{t("nav.settings")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
