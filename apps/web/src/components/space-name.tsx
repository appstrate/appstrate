// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import { useViewer } from "../hooks/use-viewer";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel } from "../lib/space-label";

type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` on a card's line, `md` in a picker row, `lg` heading a table row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: "size-4 rounded-[4px]" },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
  lg: { box: "gap-3 text-sm", tile: "size-7 rounded-md" },
} as const;

/**
 * A space as the app names it everywhere: its tile, then its name in the reader's words
 * (`spaceLabel`: « Mon espace » for the reader's own), truncated with the full name in `title`
 * unless the caller says something else there (why a closed space cannot be entered). The name is
 * raised over a table row's link (`relative z-10`, see `data-table.tsx`), or the row would swallow
 * its hover. `children` follow the name (a marker such as the default space's star).
 */
export function SpaceName({
  space,
  size = "sm",
  title,
  className,
  children,
}: {
  space: SpaceListed;
  size?: keyof typeof SIZES;
  title?: string;
  className?: string;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const viewer = useViewer();
  const label = spaceLabel(space, t);
  return (
    <span className={cn("flex min-w-0 items-center", SIZES[size].box, className)}>
      <IdentityTile {...spaceTile(space, viewer)} className={cn("shrink-0", SIZES[size].tile)} />
      <span className="relative z-10 truncate" title={title ?? label}>
        {label}
      </span>
      {children}
    </span>
  );
}
