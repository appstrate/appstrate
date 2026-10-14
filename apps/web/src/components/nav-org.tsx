// SPDX-License-Identifier: Apache-2.0

import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Layers,
  Activity,
  Calendar,
  Wrench,
  Loader2,
  Boxes,
  FileText,
  type LucideIcon,
} from "lucide-react";
import { useUnreadCount } from "../hooks/use-notifications";
import { useAgents } from "../hooks/use-packages";
import { usePaginatedRuns } from "../hooks/use-paginated-runs";
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
};

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
  const canReach = useCanReach();

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
  // Activité is what happened (dashboard, runs, files), Construire is what you
  // configure and assemble (agents, skills, integrations, schedules). A schedule
  // is a trigger you set up, like an agent, so it ends Construire.
  // Runs is rendered specially (running spinner + unread badge) inside Activité.
  // Every entry, Runs included, is shown exactly when its route's declaration
  // (`lib/route-access.ts`) opens the page it lands on — a custom space role
  // may hold none of them, so no entry is assumed reachable.
  const reachable = (items: NavItem[]) => items.filter((i) => canReach(i.path));

  const activityItems = reachable([
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    { path: "/files", label: t("nav.files"), icon: FileText },
  ]);

  // No "local MCP servers" entry: a server is the engine of a local
  // integration and reached from it, never used on its own.
  const buildItems = reachable([
    { path: "/agents", label: t("nav.agents"), icon: Layers },
    { path: "/skills", label: t("nav.skills"), icon: Wrench },
    { path: "/integrations", label: t("nav.integrations"), icon: Boxes },
    { path: "/schedules", label: t("nav.schedules"), icon: Calendar },
  ]);

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

  const canReachRuns = canReach("/runs");

  // A group whose entries are all closed to the caller is not drawn: its label
  // would head nothing.
  return (
    <>
      {(activityItems.length > 0 || canReachRuns) && (
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.section.activity")}</SidebarGroupLabel>
          <SidebarMenu>
            {renderItems(activityItems)}
            {/* Runs — with unread badge + running indicator */}
            {canReachRuns && (
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
                  <SidebarMenuBadge>
                    <span className="bg-destructive text-destructive-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] leading-none font-medium">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            )}
          </SidebarMenu>
        </SidebarGroup>
      )}

      {buildItems.length > 0 && (
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.section.build")}</SidebarGroupLabel>
          <SidebarMenu>{renderItems(buildItems)}</SidebarMenu>
        </SidebarGroup>
      )}
    </>
  );
}
