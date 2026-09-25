// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Layers,
  Activity,
  Calendar,
  Wrench,
  Plug,
  Webhook,
  Loader2,
  Users,
  Boxes,
  MessageSquare,
  FileText,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useUnreadCount } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { useChatUnreadCount } from "@appstrate/module-chat/unread";
import { buildScopingHeaders } from "../lib/scoping-headers";
import type { RoutePath } from "../lib/route-access";
import { useCanReach } from "../hooks/use-can-reach";
import { SidebarNavLink } from "./sidebar-nav-link";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";

type NavItem = {
  path: RoutePath;
  label: string;
  icon: LucideIcon;
  badge?: number;
  /** The route the link lands on, when `path` redirects there. */
  landsOn?: RoutePath;
};

export function NavOrg() {
  const { t } = useTranslation();
  const location = useLocation();
  const { data: unreadCount } = useUnreadCount();
  const { data: agents } = useAgents();
  const canReach = useCanReach();

  // Inline runs live on ephemeral shadow packages that are not in `agents`,
  // so they don't contribute to `runningRuns`. Check them separately.
  const { data: runningInline } = usePaginatedRuns({
    kind: "inline",
    status: "running",
    limit: 1,
    offset: 0,
  });
  const hasRunning =
    (agents?.some((f) => f.running_runs > 0) ?? false) || (runningInline?.total ?? 0) > 0;
  const unread = unreadCount ?? 0;
  // Unread chat replies — drives the Chat nav badge, aligned with the Runs badge.
  const chatUnread = useChatUnreadCount(buildScopingHeaders, canReach("/chat"));

  // Grouped nav: work surfaces (Activité) → build loop (Automatisation) →
  // reusable building blocks (Extensions) → admin-only config (Administration).
  // Runs is rendered specially (running spinner + unread badge) inside Activité.
  // Every entry, Runs included, is shown exactly when its route's declaration
  // (`lib/route-access.ts`) opens the page it lands on — a custom space role
  // may hold none of them, so no entry is assumed reachable.
  const reachable = (items: NavItem[]) => items.filter((i) => canReach(i.landsOn ?? i.path));

  const activityItems = reachable([
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    { path: "/chat", label: t("nav.chat"), icon: MessageSquare, badge: chatUnread },
    { path: "/files", label: t("nav.files"), icon: FileText },
  ]);

  const automationItems = reachable([
    { path: "/agents", label: t("nav.agents"), icon: Layers },
    { path: "/schedules", label: t("nav.schedules"), icon: Calendar },
  ]);

  const extensionItems = reachable([
    { path: "/skills", label: t("nav.skills"), icon: Wrench },
    { path: "/mcp-servers", label: t("nav.mcpServers"), icon: Plug },
    { path: "/integrations", label: t("nav.integrations"), icon: Boxes },
  ]);

  const adminItems = reachable([
    { path: "/webhooks", label: t("nav.webhooks"), icon: Webhook },
    { path: "/end-users", label: t("nav.endUsers"), icon: Users },
    {
      path: "/org-settings",
      landsOn: "/org-settings/general",
      label: t("nav.settings"),
      icon: Settings,
    },
  ]);

  const renderItems = (items: NavItem[]) =>
    items.map((item) => (
      <SidebarNavLink
        key={item.path}
        to={item.path}
        icon={item.icon}
        label={item.label}
        isActive={
          item.path === "/" ? location.pathname === "/" : location.pathname.startsWith(item.path)
        }
      >
        {item.badge && item.badge > 0 ? (
          <SidebarMenuBadge>
            <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
              {item.badge > 99 ? "99+" : item.badge}
            </span>
          </SidebarMenuBadge>
        ) : null}
      </SidebarNavLink>
    ));

  return (
    <>
      <SidebarGroup>
        <SidebarGroupLabel>{t("nav.section.activity")}</SidebarGroupLabel>
        <SidebarMenu>
          {renderItems(activityItems)}
          {/* Runs — with unread badge + running indicator */}
          {canReach("/runs") && (
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
          )}
        </SidebarMenu>
      </SidebarGroup>

      {automationItems.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.section.automation")}</SidebarGroupLabel>
          <SidebarMenu>{renderItems(automationItems)}</SidebarMenu>
        </SidebarGroup>
      )}

      {extensionItems.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.section.extensions")}</SidebarGroupLabel>
          <SidebarMenu>{renderItems(extensionItems)}</SidebarMenu>
        </SidebarGroup>
      )}

      {adminItems.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.section.admin")}</SidebarGroupLabel>
          <SidebarMenu>{renderItems(adminItems)}</SidebarMenu>
        </SidebarGroup>
      )}
    </>
  );
}
