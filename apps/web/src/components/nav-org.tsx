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
  Loader2,
  Boxes,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { useUnreadCount } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
import { SidebarNavLink } from "./sidebar-nav-link";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@appstrate/ui/components/sidebar";

type NavItem = { path: string; label: string; icon: LucideIcon; badge?: number };

export function NavOrg() {
  const { t } = useTranslation();
  // Subscribe to route changes even though the visible URL, not the
  // background route exposed by this tree, owns the active state below.
  useLocation();
  // Routed settings keep the underlying page mounted, so React Router exposes
  // that background location to this tree. Use the visible path to avoid
  // painting Dashboard active behind an open settings surface.
  const visiblePathname = window.location.pathname;
  const { data: unreadCount } = useUnreadCount();
  const { data: agents } = useAgents();

  // Inline runs live on ephemeral shadow packages that are not in `agents`,
  // so they don't contribute to `runningRuns`. Check them separately.
  const { data: runningInline } = usePaginatedRuns({
    kind: "inline",
    status: ["running"],
    limit: 1,
    offset: 0,
  });
  const hasRunning =
    (agents?.some((f) => f.running_runs > 0) ?? false) || (runningInline?.total ?? 0) > 0;
  const unread = unreadCount ?? 0;

  // Two groups, split by what you are DOING rather than by object type:
  // Activité is what is happening (and what is scheduled to happen), Construire
  // is what you assemble. Schedules moved out of the old "Automatisation" for
  // that reason — a schedule is upcoming activity, not a thing you build.
  // Runs is rendered specially (running spinner + unread badge) inside Activité.
  const activityItems: NavItem[] = [
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    // Module-contributed product surfaces (absent flag = entry hidden)
    { path: "/documents", label: t("nav.documents"), icon: FileText },
  ];

  const activityTailItems: NavItem[] = [
    { path: "/schedules", label: t("nav.schedules"), icon: Calendar },
  ];

  const buildItems: NavItem[] = [
    { path: "/agents", label: t("nav.agents"), icon: Layers },
    { path: "/skills", label: t("nav.skills"), icon: Wrench },
    { path: "/mcp-servers", label: t("nav.mcpServers"), icon: Plug },
    { path: "/integrations", label: t("nav.integrations"), icon: Boxes },
  ];

  const renderItems = (items: NavItem[]) =>
    items.map((item) => (
      <SidebarNavLink
        key={item.path}
        to={item.path}
        icon={item.icon}
        label={item.label}
        isActive={
          item.path === "/" ? visiblePathname === "/" : visiblePathname.startsWith(item.path)
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
          <SidebarMenuItem className="relative">
            <SidebarMenuButton
              asChild
              isActive={visiblePathname.startsWith("/runs")}
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
          {renderItems(activityTailItems)}
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup>
        <SidebarGroupLabel>{t("nav.section.build")}</SidebarGroupLabel>
        <SidebarMenu>{renderItems(buildItems)}</SidebarMenu>
      </SidebarGroup>
    </>
  );
}
