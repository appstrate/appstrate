// SPDX-License-Identifier: Apache-2.0

import { Share2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useSharedFromText } from "../hooks/use-shared-from-text";

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
