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
import { spaceLabel } from "../lib/space-label";

/** What naming a space reads of it. */
export type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` in a list's cell or a card's line, `md` in a picker row, `lg` heading a table row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: "size-4 rounded-[4px]" },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
  lg: { box: "gap-3 text-sm", tile: "size-7 rounded-md" },
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

/** No tile stacked behind a space's own. */
const NO_SPACES: readonly SpaceListed[] = [];

/** Front to back, for the tiles a {@link SpaceName} stacks (static classes, for Tailwind). */
const STACK_ORDER = ["z-[3]", "z-[2]", "z-[1]"] as const;

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
      <span className="flex shrink-0">
        {[space, ...stacked].map((tile, index) => (
          // The home tile in front: each one behind is drawn under the one before it.
          <span
            key={tile.id}
            className={cn("relative flex", STACK_ORDER[index], index > 0 && "-ml-1.5")}
          >
            <SpaceTile
              space={tile}
              size={size}
              className={cn(index > 0 && "ring-background ring-[1.5px]")}
            />
          </span>
        ))}
      </span>
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

/**
 * The working space, named while « Tous les espaces » is on: the screen showing it (a detail page,
 * a dialog an action opened) acts there, which the mode's switcher does not say. Nothing out of
 * the mode, where the switcher names it.
 */
export function WorkingSpaceName(props: Omit<Parameters<typeof SpaceNameOf>[0], "spaceId">) {
  const { on } = useOverviewMode();
  const spaceId = useCurrentSpaceId();
  return on ? <SpaceNameOf spaceId={spaceId} {...props} /> : null;
}
