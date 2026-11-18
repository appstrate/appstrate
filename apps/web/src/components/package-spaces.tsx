// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useSpaceLabelOf, useSpaces } from "../hooks/use-spaces";
import { SpaceName } from "./space-name";
import type { CardItem } from "../lib/package-card-item";

/** What naming a package's spaces reads of its row or its detail. */
export interface PackageSpacesOf {
  homeSpaceId?: CardItem["homeSpaceId"];
  spaceIds?: readonly string[];
  source?: string;
}

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
 * The spaces a package is active in (`spaceIds`), in a list spanning spaces or a detail header:
 * its home's tile with the others' stacked behind, its home's name, then the others as a count.
 * Switched off at home, its first active space leads instead. With no visible home (a system
 * package, or a home withheld from the reader) a muted label stands for it and the count covers
 * every space.
 */
export function PackageSpaces({ item }: { item: PackageSpacesOf }) {
  const { t } = useTranslation("common");
  const system = item.source === "system";
  const spaceIds = item.spaceIds ?? [];
  const labelOf = useSpaceLabelOf();
  const { data: spaces } = useSpaces();
  const home = system ? null : (item.homeSpaceId ?? null);
  const homeActive = !!home && spaceIds.includes(home);
  const lead = homeActive ? home : home ? (spaceIds[0] ?? null) : null;
  const others = spaceIds.filter((id) => id !== lead);
  const names = others.flatMap((id) => labelOf(id) ?? []);
  const leadSpace = spaces?.find((space) => space.id === lead);
  const stacked = others
    .flatMap((id) => spaces?.find((space) => space.id === id) ?? [])
    .slice(0, STACKED_TILES);
  const text = t(homeActive ? "packageSpaces.sharedWith" : "packageSpaces.availableIn", {
    names: names.join(", "),
  });
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-2">
      {leadSpace ? (
        <SpaceName space={leadSpace} stacked={stacked} />
      ) : home ? null : (
        <span className="truncate">
          {t(system ? "packageSpaces.platform" : "packageSpaces.hiddenHome")}
        </span>
      )}
      <SpacesBadge names={names} text={text} />
    </span>
  );
}

/**
 * The home's name on a detail header's meta line (`PackageOriginMeta`): said only where no tile
 * names it — the home's tile leads when the package is active there — and not while the tiles
 * are read (`spaceIds` undefined), so the line does not jump.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function homeNameBesideTiles({
  homeSpaceId,
  homeSpaceName,
  spaceIds,
}: {
  homeSpaceId: string | null;
  homeSpaceName?: string | null;
  spaceIds: readonly string[] | undefined;
}): string | null | undefined {
  if (!spaceIds || (homeSpaceId && spaceIds.includes(homeSpaceId))) return null;
  return homeSpaceName;
}
