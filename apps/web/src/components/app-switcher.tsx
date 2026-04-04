// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check, Star, Settings, AppWindow } from "lucide-react";
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export function AppSwitcher() {
  const { t } = useTranslation();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const { isMobile } = useSidebar();

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  if (!currentApp) return null;

  // Hide switcher when there's only one app (transparent for basic users)
  const hasMultipleApps = (applications?.length ?? 0) > 1;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="sm"
              aria-label={t("switcher.appAriaLabel")}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <AppWindow className="size-4" />
              <span className="flex-1 truncate text-sm">{currentApp.name}</span>
              {hasMultipleApps && <ChevronsUpDown className="ml-auto size-4" />}
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
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
                  <span className="flex items-center gap-1.5 truncate">
                    {app.name}
                    {app.isDefault && (
                      <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
                    )}
                  </span>
                  {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/applications" className="text-primary flex items-center gap-2">
                <Settings size={14} />
                {t("switcher.manageApps")}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
