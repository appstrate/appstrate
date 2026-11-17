// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import { useViewer } from "../hooks/use-viewer";
import { useSpaces } from "../hooks/use-spaces";
import { useCurrentSpaceId } from "../hooks/use-current-space";
import { useOverviewMode } from "../hooks/use-overview-mode";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel } from "../lib/space-label";

/** What naming a space reads of it. */
type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` in a list's cell or a card's line, `md` in a picker row, `lg` heading a table row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: "size-4 rounded-[4px]" },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
  lg: { box: "gap-3 text-sm", tile: "size-7 rounded-md" },
} as const;

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
  const viewer = useViewer();
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
            <IdentityTile
              {...spaceTile(tile, viewer)}
              className={cn(
                "shrink-0",
                SIZES[size].tile,
                index > 0 && "ring-background ring-[1.5px]",
              )}
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
 * The working space, named while « Tous les espaces » is on: the screen showing it (a detail page,
 * a dialog an action opened) acts there, which the mode's switcher does not say. Nothing out of
 * the mode, where the switcher names it.
 */
export function WorkingSpaceName(props: Omit<Parameters<typeof SpaceNameOf>[0], "spaceId">) {
  const { on } = useOverviewMode();
  const spaceId = useCurrentSpaceId();
  return on ? <SpaceNameOf spaceId={spaceId} {...props} /> : null;
}
