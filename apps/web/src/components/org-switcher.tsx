// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check, Plus, Star, Settings, LayoutGrid } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId, useAppSwitcher } from "../hooks/use-current-application";
import { usePermissions } from "../hooks/use-permissions";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={cn(
        "bg-sidebar-primary text-sidebar-primary-foreground flex items-center justify-center rounded-lg font-medium",
        className,
      )}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const { isMobile } = useSidebar();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();
  const { isAdmin } = usePermissions();

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;
  const hasMultipleApps = (applications?.length ?? 0) > 1;

  if (loading) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuSkeleton showIcon />
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (!currentOrg) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={t("switcher.orgAriaLabel")}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <OrgAvatar name={currentOrg.name} className="aspect-square size-7 text-sm" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{currentOrg.name}</span>
                {currentApp && (
                  <span className="text-muted-foreground truncate text-xs">{currentApp.name}</span>
                )}
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              {t("switcher.orgAriaLabel")}
            </DropdownMenuLabel>
            {orgs.map((org) => {
              const isActive = org.id === currentOrg.id;
              return (
                <DropdownMenuItem
                  key={org.id}
                  className="flex items-center gap-2"
                  onSelect={() => {
                    if (!isActive) switchOrg(org.id);
                  }}
                >
                  <OrgAvatar name={org.name} className="size-6 rounded-md text-xs" />
                  <span className="flex-1 truncate">{org.name}</span>
                  {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            {hasMultipleApps && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="flex items-center gap-2">
                  <span className="flex-1 truncate">{currentApp?.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-48 rounded-lg">
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
                          if (!isActive) switchApp(app.id);
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
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuItem asChild>
              <Link
                to="/onboarding/create"
                state={{ fromSwitcher: true }}
                className="text-primary flex items-center gap-2"
              >
                <Plus size={14} />
                {t("switcher.createOrg")}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/applications" className="text-primary flex items-center gap-2">
                <LayoutGrid size={14} />
                {t("switcher.manageApps")}
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link to="/org-settings" className="text-primary flex items-center gap-2">
                  <Settings size={14} />
                  {t("nav.settings")}
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
