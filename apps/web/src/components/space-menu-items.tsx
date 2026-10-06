// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check, Star } from "lucide-react";
import { useSpaces } from "../hooks/use-spaces";
import { isSpaceEnterable, useCurrentSpaceId, useSpaceSwitcher } from "../hooks/use-current-space";
import { spaceRoleLabel } from "../hooks/use-roles";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@appstrate/ui/components/dropdown-menu";
import { spaceLabel } from "../lib/space-label";

/** The ONE list both space selectors render, so they cannot disagree on what may be entered. */
export function SpaceMenuItems() {
  const { t } = useTranslation(["common", "settings"]);
  const { data: spaces = [] } = useSpaces();
  const currentSpaceId = useCurrentSpaceId();
  const { switchSpace } = useSpaceSwitcher();
  const personalSpaces = spaces.filter((s) => s.personal);
  const teamSpaces = spaces.filter((s) => !s.personal);

  const renderItem = (space: (typeof spaces)[number]) => {
    const isActive = space.id === currentSpaceId;
    const enterable = isSpaceEnterable(space);
    return (
      <DropdownMenuItem
        key={space.id}
        data-testid={`space-item-${space.id}`}
        className="flex items-center justify-between gap-2"
        disabled={!enterable}
        title={enterable ? undefined : t("spaces.requestAccess", { ns: "settings" })}
        onSelect={() => {
          if (enterable && !isActive) switchSpace(space.id);
        }}
      >
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 truncate">
            {spaceLabel(space, t)}
            {space.isDefault && (
              <Star size={12} className="shrink-0 fill-amber-500 text-amber-500" />
            )}
          </span>
          {enterable && space.role && (
            <span className="text-muted-foreground truncate text-xs">
              {spaceRoleLabel(space.role, t)}
            </span>
          )}
          {!enterable && (
            <span className="text-muted-foreground truncate text-xs">
              {t("spaces.requestAccess", { ns: "settings" })}
            </span>
          )}
        </span>
        {isActive && <Check size={14} strokeWidth={2.5} className="shrink-0" />}
      </DropdownMenuItem>
    );
  };

  return (
    <>
      {personalSpaces.length > 0 && (
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          {t("spaces.personal.switcherGroup", { ns: "settings" })}
        </DropdownMenuLabel>
      )}
      {personalSpaces.map(renderItem)}
      {personalSpaces.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-muted-foreground text-xs">
        {personalSpaces.length > 0
          ? t("spaces.personal.teamGroup", { ns: "settings" })
          : t("switcher.spaceAriaLabel")}
      </DropdownMenuLabel>
      {teamSpaces.map(renderItem)}
    </>
  );
}
