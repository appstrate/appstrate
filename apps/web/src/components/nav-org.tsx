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
import { useFlows } from "../hooks/use-packages";
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
  const { data: flows } = useFlows();
  const { isAdmin } = usePermissions();

  const hasRunning = flows?.some((f) => f.runningExecutions > 0) ?? false;
  const unread = unreadCount ?? 0;

  const automationItems = [
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    { path: "/flows", label: t("nav.flows"), icon: Layers },
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
              isActive={location.pathname.startsWith("/executions")}
              tooltip={t("nav.executions")}
            >
              <Link to="/executions">
                <span className="flex size-4 items-center justify-center shrink-0">
                  {hasRunning ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Activity size={16} />
                  )}
                </span>
                <span>{t("nav.executions")}</span>
              </Link>
            </SidebarMenuButton>
            {unread > 0 && (
              <>
                <SidebarMenuBadge>
                  <span className="flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[0.6rem] font-medium leading-none">
                    {unread > 99 ? "99+" : unread}
                  </span>
                </SidebarMenuBadge>
                <span className="pointer-events-none absolute top-1 right-1 size-2 rounded-full ring-2 ring-sidebar bg-destructive hidden group-data-[collapsible=icon]:block" />
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
