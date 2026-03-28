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
} from "lucide-react";
import { useOrg } from "../hooks/use-org";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function NavOrg() {
  const { t } = useTranslation();
  const { isOrgAdmin } = useOrg();
  const location = useLocation();

  const items = [
    { path: "/", label: t("nav.dashboard"), icon: LayoutDashboard },
    { path: "/flows", label: t("nav.flows"), icon: Layers },
    { path: "/executions", label: t("nav.executions"), icon: Activity },
    { path: "/schedules", label: t("nav.schedules"), icon: Calendar },
    { path: "/skills", label: t("nav.skills"), icon: Wrench },
    { path: "/tools", label: t("nav.tools"), icon: Puzzle },
    { path: "/providers", label: t("nav.connectors"), icon: Plug },
  ];

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{t("nav.orgSection")}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.path}>
            <SidebarMenuButton
              asChild
              isActive={
                item.path === "/"
                  ? location.pathname === "/"
                  : location.pathname.startsWith(item.path)
              }
              tooltip={item.label}
            >
              <Link to={item.path}>
                <item.icon />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
        {isOrgAdmin && (
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
  );
}
