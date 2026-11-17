// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Share2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useSharedFromText } from "../hooks/use-shared-from-text";
import { useSpaceLabelOf } from "../hooks/use-spaces";
import { SpaceNameOf } from "./space-name";

/** The count of the spaces a package reaches beyond its home, the names in a tooltip. */
function SpacesBadge({ names, text }: { names: readonly string[]; text: string }) {
  if (names.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          role="img"
          aria-label={text}
          className="text-muted-foreground relative z-10 flex shrink-0 items-center gap-0.5 tabular-nums"
        >
          <Share2 className="size-3" aria-hidden />
          {names.length}
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The spaces of a package in a list spanning spaces: its home, then the others it is shared
 * into as a count. With no visible home (a system package, or a home withheld from the reader)
 * a muted label stands for it and the count covers every space.
 */
export function PackageSpaces({
  homeSpaceId,
  spaceIds,
  system,
}: {
  homeSpaceId: string | null | undefined;
  spaceIds: readonly string[];
  system: boolean;
}) {
  const { t } = useTranslation("common");
  const labelOf = useSpaceLabelOf();
  const home = system ? null : (homeSpaceId ?? null);
  const names = spaceIds.filter((id) => id !== home).flatMap((id) => labelOf(id) ?? []);
  const text = t(home ? "packageSpaces.sharedWith" : "packageSpaces.availableIn", {
    names: names.join(", "),
  });
  return (
    <span className="text-muted-foreground flex min-w-0 items-center gap-2">
      {home ? (
        <SpaceNameOf spaceId={home} />
      ) : (
        <span className="truncate">
          {t(system ? "packageSpaces.platform" : "packageSpaces.hiddenHome")}
        </span>
      )}
      <SpacesBadge names={names} text={text} />
    </span>
  );
}

/** {@link useSharedFromText} as a table's icon, the text in a tooltip. */
export function PackageSharedFrom({
  homeSpaceId,
  system,
}: {
  homeSpaceId: string | null | undefined;
  system: boolean;
}) {
  const text = useSharedFromText(homeSpaceId, system);
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="text-muted-foreground relative z-10 shrink-0">
          <Share2 className="size-3.5" role="img" aria-label={text} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
