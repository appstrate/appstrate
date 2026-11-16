// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import { useViewer } from "../hooks/use-auth";
import { useSpaceLabelOf, useSpaces, useSpacesOf } from "../hooks/use-spaces";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel } from "../lib/space-label";

type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` in a list's cell or a card's line, `md` in a picker row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: "size-4 rounded-[4px]" },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
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
 * Several spaces' tiles stacked, each overlapping the previous one, ringed in `ringClassName` (the
 * colour of the surface they sit on) so the edges stay readable. Past `max`, the rest is counted.
 */
export function SpaceTileStack({
  spaces,
  size = "sm",
  max,
  ringClassName = "ring-background",
}: {
  spaces: readonly (SpaceListed & { id: string })[];
  size?: keyof typeof SIZES;
  max?: number;
  ringClassName?: string;
}) {
  const shown = max === undefined ? spaces : spaces.slice(0, max);
  const hidden = spaces.length - shown.length;
  return (
    <span className="flex shrink-0 items-center -space-x-1" data-testid="space-tile-stack">
      {shown.map((space) => (
        <SpaceTile
          key={space.id}
          space={space}
          size={size}
          className={cn("ring-2", ringClassName)}
        />
      ))}
      {hidden > 0 && (
        <span
          className={cn(
            "bg-muted text-muted-foreground flex shrink-0 items-center justify-center text-[10px] leading-none font-medium tabular-nums ring-2",
            SIZES[size].tile,
            ringClassName,
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
 * The spaces of a row listed once for several (`onePerPackage`): the first named, the others
 * counted (« +2 »), their names in `title`.
 */
export function SpaceNamesOf({
  spaceIds,
  ...props
}: { spaceIds: readonly string[] } & Omit<Parameters<typeof SpaceName>[0], "space" | "children">) {
  const labelOf = useSpaceLabelOf();
  const others = spaceIds.slice(1).flatMap((id) => labelOf(id) ?? []);
  return (
    <SpaceNameOf spaceId={spaceIds[0]} {...props}>
      {others.length > 0 && (
        <span className="shrink-0 tabular-nums" title={others.join(", ")}>
          +{others.length}
        </span>
      )}
    </SpaceNameOf>
  );
}

/**
 * Every space a row touched, none counted away: all the tiles in a row, then the names joined
 * (« Studio, Coffre »), truncated with the full names in `title`. One space reads as
 * {@link SpaceName}. For a list of conversations; {@link SpaceNamesOf} stays the cards' line.
 */
export function SpaceTilesOf({
  spaceIds,
  size = "sm",
  className,
  ringClassName,
}: {
  spaceIds: readonly string[];
  size?: keyof typeof SIZES;
  className?: string;
  /** The surface colour the stacked tiles are ringed in (see {@link SpaceTileStack}). */
  ringClassName?: string;
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
      <SpaceTileStack spaces={spaces} size={size} ringClassName={ringClassName} />
      <span className="truncate" title={names}>
        {names}
      </span>
    </span>
  );
}
