import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users, KeyRound, Settings, Check, Star, ChevronsUpDown } from "lucide-react";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId, setCurrentApplicationId } from "../hooks/use-current-application";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export function NavApp() {
  const { t } = useTranslation();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const location = useLocation();
  const { isMobile } = useSidebar();

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  if (!currentApp) return null;

  const items = [
    { path: "/end-users", label: t("nav.endUsers"), icon: Users },
    { path: "/api-keys", label: t("nav.apiKeys"), icon: KeyRound },
  ];

  return (
    <SidebarGroup>
      <SidebarGroupLabel className="group-data-[collapsible=icon]:hidden">
        <span className="flex-1">{t("nav.appSection")}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              aria-label={t("switcher.appAriaLabel")}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
            >
              <span className="truncate max-w-20">{currentApp.name}</span>
              <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56 rounded-lg"
            align="end"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("switcher.appAriaLabel")}
            </DropdownMenuLabel>
            {(applications ?? []).map((app) => {
              const isActive = app.id === currentAppId;
              return (
                <DropdownMenuItem
                  key={app.id}
                  className="flex items-center justify-between gap-2"
                  onSelect={() => {
                    if (!isActive) setCurrentApplicationId(app.id);
                  }}
                >
                  <span className="truncate flex items-center gap-1.5">
                    {app.name}
                    {app.isDefault && (
                      <Star size={12} className="text-amber-500 fill-amber-500 shrink-0" />
                    )}
                  </span>
                  {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/applications" className="flex items-center gap-2 text-primary">
                <Settings size={14} />
                {t("switcher.manageApps")}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <SidebarMenuItem key={item.path}>
            <SidebarMenuButton
              asChild
              isActive={location.pathname.startsWith(item.path)}
              tooltip={item.label}
            >
              <Link to={item.path}>
                <item.icon />
                <span>{item.label}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
