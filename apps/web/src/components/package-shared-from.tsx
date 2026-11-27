// SPDX-License-Identifier: Apache-2.0

import { FolderInput } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { useSharedFromText } from "../hooks/use-shared-from-text";

/**
 * {@link useSharedFromText} under a provenance icon: in a table the icon alone, the text in a
 * tooltip; `inline` on a card's meta line, the text beside it.
 */
export function PackageSharedFrom({
  homeSpaceId,
  system,
  inline = false,
}: {
  homeSpaceId: string | null | undefined;
  system: boolean;
  inline?: boolean;
}) {
  const text = useSharedFromText(homeSpaceId, system);
  if (!text) return null;
  if (inline) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <FolderInput className="size-3 shrink-0" aria-hidden />
        <span className="truncate" title={text}>
          {text}
        </span>
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} className="text-muted-foreground relative z-10 shrink-0" />}
      >
        <FolderInput className="size-3.5" role="img" aria-label={text} />
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  );
}
