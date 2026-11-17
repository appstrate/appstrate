// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useSpaceLabelOf, useSpaces } from "../hooks/use-spaces";
import { SpaceName } from "./space-name";
import type { CardItem } from "../lib/package-card-item";

/** What naming a package's spaces reads of its row. */
export type PackageSpacesOf = Pick<CardItem, "homeSpaceId" | "spaceIds" | "source">;

/**
 * The count of the spaces a package reaches beyond its home, as « +2 », the names in a tooltip.
 */
function SpacesBadge({ names, text }: { names: readonly string[]; text: string }) {
  if (names.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={text}
          className="text-muted-foreground relative z-10 shrink-0 tabular-nums"
        >
          {`+${names.length}`}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/** Tiles drawn for a package's spaces: its home's and at most this many others behind it. */
const STACKED_TILES = 2;

/**
 * The spaces of a package in a list spanning spaces: its home's tile with the others' stacked
 * behind, its home's name, then the others as a count. With no visible home (a system package, or a home withheld from the reader)
 * a muted label stands for it and the count covers every space.
 */
export function PackageSpaces({ item }: { item: PackageSpacesOf }) {
  const { t } = useTranslation("common");
  const system = item.source === "system";
  const spaceIds = item.spaceIds ?? [];
  const labelOf = useSpaceLabelOf();
  const { data: spaces } = useSpaces();
  const home = system ? null : (item.homeSpaceId ?? null);
  const others = spaceIds.filter((id) => id !== home);
  const names = others.flatMap((id) => labelOf(id) ?? []);
  const homeSpace = spaces?.find((space) => space.id === home);
  const stacked = others
    .flatMap((id) => spaces?.find((space) => space.id === id) ?? [])
    .slice(0, STACKED_TILES);
  const text = t(home ? "packageSpaces.sharedWith" : "packageSpaces.availableIn", {
    names: names.join(", "),
  });
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-2">
      {homeSpace ? (
        <SpaceName space={homeSpace} stacked={stacked} />
      ) : home ? null : (
        <span className="truncate">
          {t(system ? "packageSpaces.platform" : "packageSpaces.hiddenHome")}
        </span>
      )}
      <SpacesBadge names={names} text={text} />
    </span>
  );
}
