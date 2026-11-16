// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { cn } from "@appstrate/ui/cn";
import { useViewer } from "../hooks/use-viewer";
import { useSpaceLabelOf, useSpaces } from "../hooks/use-spaces";
import { spaceTile } from "../lib/identity-tile-props";
import { spaceLabel } from "../lib/space-label";

type SpaceListed = Parameters<typeof spaceTile>[0];

/** The tile and text of each size: `sm` in a list's cell or a card's line, `md` in a picker row. */
const SIZES = {
  sm: { box: "gap-1.5 text-xs", tile: "size-4 rounded-[4px]" },
  md: { box: "gap-2.5 text-sm", tile: "size-6" },
} as const;

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
  const viewer = useViewer();
  const label = spaceLabel(space, t);
  return (
    <span className={cn("flex min-w-0 items-center", SIZES[size].box, className)}>
      <IdentityTile {...spaceTile(space, viewer)} className={cn("shrink-0", SIZES[size].tile)} />
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
