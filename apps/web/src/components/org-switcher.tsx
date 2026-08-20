// SPDX-License-Identifier: Apache-2.0

import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Check, Plus, Star, Library } from "lucide-react";
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
} from "@appstrate/ui/components/dropdown-menu";
import { Skeleton } from "@appstrate/ui/components/skeleton";
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
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();
  const { isAdmin } = usePermissions();

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  if (loading) {
    return <Skeleton className="h-6 w-40" />;
  }

  if (!currentOrg) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Deliberately NOT shaped like the trail segments next to it. A
            breadcrumb segment means "go up a level" — cheap and reversible.
            This one replaces the whole context. The coloured avatar and the
            up/down chevron (never a right chevron) are what say so. */}
        <button
          type="button"
          data-testid="org-switcher-button"
          aria-label={t("switcher.orgAriaLabel")}
          className="hover:bg-accent data-[state=open]:bg-accent flex min-w-0 shrink items-center gap-1.5 rounded-md py-1 pr-1.5 pl-1 text-sm transition-colors"
        >
          <OrgAvatar name={currentOrg.name} className="size-5 rounded-[5px] text-[0.65rem]" />
          <span className="truncate font-semibold">{currentOrg.name}</span>
          {currentApp && (
            <>
              {/* The workspace stays visible even when there is only one: the
                  concept has to be discoverable, and a level nobody ever sees
                  is a level nobody learns. */}
              <span className="text-border" aria-hidden>
                |
              </span>
              <span className="truncate font-semibold">{currentApp.name}</span>
            </>
          )}
          <ChevronsUpDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-56 rounded-lg"
        align="start"
        side="bottom"
        sideOffset={6}
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
        {/* Labelled even when there is a single application, because the chip
            now shows it permanently: an unexplained "Default" row teaches
            nothing, which was the point of keeping it visible. */}
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          {t("switcher.appSection")}
        </DropdownMenuLabel>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            data-testid="app-submenu-trigger"
            className="flex items-center gap-2"
          >
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
                  data-testid={`app-item-${app.id}`}
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
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link
                to="/org-settings/applications"
                className="text-primary flex items-center gap-2"
              >
                <Plus size={14} />
                {t("switcher.createApp")}
              </Link>
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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
  );
}
