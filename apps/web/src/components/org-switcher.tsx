// SPDX-License-Identifier: Apache-2.0

import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check, Plus, Star, Library } from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useSpaces } from "../hooks/use-spaces";
import { useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
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
} from "@appstrate/ui/components/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@appstrate/ui/components/sidebar";
import { useSidebar } from "@appstrate/ui/components/sidebar-context";
import { cn } from "@appstrate/ui/cn";

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
  const navigate = useNavigate();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const { isMobile } = useSidebar();
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const { isAdmin } = usePermissions();

  const currentSpace = spaces?.find((s) => s.id === currentSpaceId) ?? null;
  const hasMultipleSpaces = (spaces?.length ?? 0) > 1;

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
              data-testid="org-switcher-button"
              aria-label={t("switcher.orgAriaLabel")}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <OrgAvatar name={currentOrg.name} className="aspect-square size-8 text-sm" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{currentOrg.name}</span>
                {currentSpace && (
                  <span className="text-muted-foreground truncate text-xs">
                    {currentSpace.name}
                  </span>
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
                  data-testid={`org-item-${org.id}`}
                  className="flex items-center gap-2"
                  onSelect={() => {
                    if (!isActive) {
                      switchOrg(org.id);
                      navigate("/", { replace: true });
                    }
                  }}
                >
                  <OrgAvatar name={org.name} className="size-6 rounded-md text-xs" />
                  <span className="flex-1 truncate">{org.name}</span>
                  {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            {hasMultipleSpaces && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  data-testid="space-submenu-trigger"
                  className="flex items-center gap-2"
                >
                  <span className="flex-1 truncate">{currentSpace?.name}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-48 rounded-lg">
                  <DropdownMenuLabel className="text-muted-foreground text-xs">
                    {t("switcher.spaceAriaLabel")}
                  </DropdownMenuLabel>
                  {(spaces ?? []).map((space) => {
                    const isActive = space.id === currentSpaceId;
                    return (
                      <DropdownMenuItem
                        key={space.id}
                        data-testid={`space-item-${space.id}`}
                        className="flex items-center justify-between gap-2"
                        onSelect={() => {
                          if (!isActive) switchSpace(space.id);
                        }}
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          {space.name}
                          {space.isDefault && (
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
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link to="/library" className="text-primary flex items-center gap-2">
                  <Library size={14} />
                  {t("nav.library")}
                </Link>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
