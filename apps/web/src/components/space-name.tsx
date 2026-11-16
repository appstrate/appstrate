// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import { useViewer } from "../hooks/use-viewer";
import { useSpaces, useSpacesOf } from "../hooks/use-spaces";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel } from "../lib/space-label";

/** A listed space as the tile and name components take it. */
export type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` in a list's cell or a card's line, `md` in a picker row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: "size-4 rounded-[4px]" },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
} as const;

/** A space's tile at one of the {@link SIZES}: the one tile every space listing draws. */
function SpaceTile({
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

/** The ring of a stacked tile: the container's `--space-tile-ring`, else the page background. */
const RING = "ring-(--space-tile-ring,var(--background))";

/**
 * Several spaces' tiles stacked, each overlapping the previous one, ringed in `--space-tile-ring`
 * (the colour of the surface they sit on, which the container sets for each of its states: a
 * conversation row or the chat's top-bar trigger; `--background` when none does) so the edges
 * stay readable. Past `max`, the rest is counted.
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
  const shown = max === undefined ? spaces : spaces.slice(0, max);
  const hidden = spaces.length - shown.length;
  return (
    <span className="flex shrink-0 items-center -space-x-1" data-testid="space-tile-stack">
      {shown.map((space) => (
        <SpaceTile key={space.id} space={space} size={size} className={cn("ring-2", RING)} />
      ))}
      {hidden > 0 && (
        <span
          className={cn(
            "bg-muted text-muted-foreground flex shrink-0 items-center justify-center text-[10px] leading-none font-medium tabular-nums ring-2",
            SIZES[size].tile,
            RING,
          )}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}

/**
 * A space as the app names it everywhere: its tile, then its name in the reader's words
 * (`spaceLabel`: « Mon espace » for the reader's own), truncated with the full name in `title`.
 * `children` follow the name (a marker such as the default space's star).
 */
export function SpaceName({
  space,
  size = "sm",
  className,
  children,
}: {
  space: SpaceListed;
  size?: keyof typeof SIZES;
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const label = spaceLabel(space, t);
  return (
    <span className={cn("flex min-w-0 items-center", SIZES[size].box, className)}>
      <SpaceTile space={space} size={size} />
      <span className="truncate" title={label}>
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
 * Every space a row touched, none counted away: all the tiles in a row, then the names joined
 * (« Studio, Coffre »), truncated with the full names in `title`. One space reads as
 * {@link SpaceName}. The line of a conversation's spaces.
 */
export function SpaceTilesOf({
  spaceIds,
  size = "sm",
  className,
}: {
  spaceIds: readonly string[];
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const { t } = useTranslation();
  const spaces = useSpacesOf(spaceIds);
  if (spaces.length === 0) return null;
  if (spaces.length === 1)
    return <SpaceName space={spaces[0]!} size={size} className={className} />;
  const names = spaces.map((space) => spaceLabel(space, t)).join(", ");
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
