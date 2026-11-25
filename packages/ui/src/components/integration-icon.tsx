// SPDX-License-Identifier: Apache-2.0

import { Puzzle } from "lucide-react";
import { parseIcon } from "@appstrate/core/appearance";
import { cn } from "../cn.ts";
import { ManifestGlyph } from "./manifest-glyph.tsx";

/** A manifest logo on a light background keeps the brand readable in either theme. */
export function IntegrationIcon({
  src,
  className = "size-4 rounded-sm",
  padding,
  fallbackClassName = "size-full",
}: {
  src?: string | null;
  className?: string;
  padding?: string;
  fallbackClassName?: string;
}) {
  const icon = parseIcon(src);
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        icon ? "bg-white text-neutral-900" : "bg-muted text-muted-foreground",
        className,
        icon && padding,
      )}
    >
      {icon ? (
        <ManifestGlyph
          icon={icon}
          className="size-full"
          fallback={<Puzzle className={cn("text-neutral-400", fallbackClassName)} />}
        />
      ) : (
        <Puzzle className={fallbackClassName} />
      )}
    </span>
  );
}
