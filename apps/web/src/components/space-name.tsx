// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import { useViewer } from "../hooks/use-viewer";
import { useSpaces, useSpacesOf } from "../hooks/use-spaces";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel, spaceLabels } from "../lib/space-label";
import { STACK_TILE, TileStack } from "./tile-stack";

/** What naming a space reads of it. */
export type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` in a list's cell or a card's line, `md` in a picker row, `lg` heading a table row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: STACK_TILE },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
  lg: { box: "gap-3 text-sm", tile: "size-7 rounded-md" },
} as const;

/** A space's tile at one of the {@link SIZES}: the one tile every space listing draws. */
export function SpaceTile({
  space,
  size = "sm",
  className,
}: {
  space: SpaceListed;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const viewer = useViewer();
  return (
    <IdentityTile
      {...spaceTile(space, viewer)}
      className={cn("shrink-0", SIZES[size].tile, className)}
    />
  );
}

/**
 * Several spaces' tiles stacked ({@link TileStack}): the first in front and each next one behind
 * it. Past `max`, the rest is counted.
 */
export function SpaceTileStack({
  spaces,
  size = "sm",
  max,
}: {
  spaces: readonly (SpaceListed & { id: string })[];
  size?: keyof typeof SIZES;
  max?: number;
}) {
  return (
    <TileStack
      items={spaces}
      keyOf={(space) => space.id}
      render={(space, className) => <SpaceTile space={space} size={size} className={className} />}
      tileClass={SIZES[size].tile}
      max={max}
      testId="space-tile-stack"
    />
  );
}

/** No tile stacked behind a space's own. */
const NO_SPACES: readonly SpaceListed[] = [];

/**
 * A space as the app names it everywhere: its tile, then its name in the reader's words
 * (`spaceLabel`: « Mon espace » for the reader's own), truncated with the full name in `title`
 * unless the caller says something else there (why a closed space cannot be entered). The name is
 * raised over a table row's link (`relative z-10`, see `data-table.tsx`), or the row would swallow
 * its hover. `stacked` spaces draw their tiles overlapping behind its own (the other spaces of a
 * package listed in several). `children` follow the name (a marker such as the default space's star).
 */
export function SpaceName({
  space,
  size = "sm",
  title,
  stacked = NO_SPACES,
  className,
  children,
}: {
  space: SpaceListed;
  size?: keyof typeof SIZES;
  title?: string;
  stacked?: readonly SpaceListed[];
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const label = spaceLabel(space, t);
  return (
    <span className={cn("flex min-w-0 items-center", SIZES[size].box, className)}>
      {stacked.length > 0 ? (
        <SpaceTileStack spaces={[space, ...stacked]} size={size} />
      ) : (
        <SpaceTile space={space} size={size} />
      )}
      <span className="relative z-10 truncate" title={title ?? label}>
        {label}
      </span>
      {children}
    </span>
  );
}

/** {@link SpaceName} of a space named by id, read from the space listing; nothing while unknown. */
export function SpaceNameOf({
  spaceId,
  ...props
}: { spaceId: string | null | undefined } & Omit<Parameters<typeof SpaceName>[0], "space">) {
  const { data: spaces } = useSpaces();
  const space = spaces?.find((s) => s.id === spaceId);
  return space ? <SpaceName space={space} {...props} /> : null;
}

/**
 * Every space a row touched: the tiles, then the names joined (« Studio, Coffre »), truncated with
 * the full names in `title`; one space reads as {@link SpaceName}. With `tilesOnly`, for a line with
 * no room for the names, two tiles at most then « +N », the names in `title` and for a screen
 * reader. The line of a conversation's spaces.
 */
export function SpaceTilesOf({
  spaceIds,
  size = "sm",
  className,
  tilesOnly = false,
}: {
  spaceIds: readonly string[];
  size?: keyof typeof SIZES;
  className?: string;
  /** The tiles alone, two at most then « +N »: for a line with no room for the names. */
  tilesOnly?: boolean;
}) {
  const { t } = useTranslation();
  const spaces = useSpacesOf(spaceIds);
  if (spaces.length === 0) return null;
  const names = spaceLabels(spaces, t);
  if (tilesOnly)
    return (
      <span className={cn("flex shrink-0 items-center", className)} title={names}>
        <SpaceTileStack spaces={spaces} size={size} max={2} />
        <span className="sr-only">{names}</span>
      </span>
    );
  if (spaces.length === 1)
    return <SpaceName space={spaces[0]!} size={size} className={className} />;
  return (
    <span
      className={cn("flex min-w-0 items-center", SIZES[size].box, className)}
      data-testid="space-tiles"
    >
      <SpaceTileStack spaces={spaces} size={size} />
      <span className="truncate" title={names}>
        {names}
      </span>
    </span>
  );
}

/**
 * The working space, named while « Tous les espaces » is on: the screen showing it (a detail page,
 * a dialog an action opened) acts there, which the mode's switcher does not say. Nothing out of
 * the mode, where the switcher names it.
 */
export function WorkingSpaceName({
  spaceId,
  ...props
}: Omit<Parameters<typeof SpaceNameOf>[0], "spaceId"> & { spaceId?: string }) {
  const { on } = useOverviewMode();
  const workingSpaceId = useCurrentSpaceId();
  return on ? <SpaceNameOf spaceId={spaceId ?? workingSpaceId} {...props} /> : null;
}
