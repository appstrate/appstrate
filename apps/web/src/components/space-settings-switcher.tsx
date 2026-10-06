// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Star } from "lucide-react";
import { useSpaces } from "../hooks/use-spaces";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import { spaceLabel } from "../lib/space-label";
import { SpaceMenuItems } from "./space-menu-items";

export function SpaceSettingsSwitcher() {
  const { t } = useTranslation(["common", "settings"]);
  const { data: spaces } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();

  const currentSpace = spaces?.find((s) => s.id === currentSpaceId) ?? null;

  if (!currentSpace) return null;

  const name = (
    <>
      {spaceLabel(currentSpace, t)}
      {currentSpace.isDefault && (
        <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
      )}
    </>
  );

  if ((spaces?.length ?? 0) <= 1) {
    return (
      <span className="text-foreground inline-flex items-center gap-1.5 text-sm font-normal">
        {name}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("switcher.spaceAriaLabel")}
        className="text-foreground hover:text-foreground focus-visible:ring-ring data-[state=open]:bg-accent inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm outline-none focus-visible:ring-2"
      >
        <span className="inline-flex items-center gap-1.5 truncate">{name}</span>
        <ChevronsUpDown size={12} className="shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-(--radix-dropdown-menu-trigger-width) min-w-48 rounded-lg"
        align="start"
        side="bottom"
        sideOffset={4}
      >
        <SpaceMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
