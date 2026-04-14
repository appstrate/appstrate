// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Star } from "lucide-react";
import { useApplications } from "../hooks/use-applications";
import { useCurrentApplicationId, useAppSwitcher } from "../hooks/use-current-application";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AppSettingsSwitcher() {
  const { t } = useTranslation();
  const { data: applications } = useApplications();
  const currentAppId = useCurrentApplicationId();
  const { switchApp } = useAppSwitcher();

  const currentApp = applications?.find((a) => a.id === currentAppId) ?? null;

  if (!currentApp) return null;

  const hasMultipleApps = (applications?.length ?? 0) > 1;

  if (!hasMultipleApps) {
    return (
      <span className="text-foreground inline-flex items-center gap-1.5 text-sm font-normal">
        {currentApp.name}
        {currentApp.isDefault && (
          <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
        )}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("switcher.appAriaLabel")}
        className="text-foreground hover:text-foreground focus-visible:ring-ring data-[state=open]:bg-accent inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm outline-none focus-visible:ring-2"
      >
        <span className="inline-flex items-center gap-1.5 truncate">
          {currentApp.name}
          {currentApp.isDefault && (
            <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
          )}
        </span>
        <ChevronsUpDown size={12} className="shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-48 rounded-lg"
        align="start"
        side="bottom"
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
              data-testid={`app-settings-item-${app.id}`}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
