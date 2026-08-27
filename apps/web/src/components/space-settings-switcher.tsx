// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check, ChevronsUpDown, Star } from "lucide-react";
import { useSpaces } from "../hooks/use-spaces";
import { useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";

export function SpaceSettingsSwitcher() {
  const { t } = useTranslation();
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();

  const currentSpace = spaces?.find((s) => s.id === currentSpaceId) ?? null;

  if (!currentSpace) return null;

  const hasMultipleSpaces = (spaces?.length ?? 0) > 1;

  if (!hasMultipleSpaces) {
    return (
      <span className="text-foreground inline-flex items-center gap-1.5 text-sm font-normal">
        {currentSpace.name}
        {currentSpace.isDefault && (
          <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
        )}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("switcher.spaceAriaLabel")}
        className="text-foreground hover:text-foreground focus-visible:ring-ring data-[state=open]:bg-accent inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm outline-none focus-visible:ring-2"
      >
        <span className="inline-flex items-center gap-1.5 truncate">
          {currentSpace.name}
          {currentSpace.isDefault && (
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
          {t("switcher.spaceAriaLabel")}
        </DropdownMenuLabel>
        {(spaces ?? []).map((space) => {
          const isActive = space.id === currentSpaceId;
          return (
            <DropdownMenuItem
              key={space.id}
              data-testid={`space-settings-item-${space.id}`}
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
