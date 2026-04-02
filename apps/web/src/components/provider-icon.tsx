// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/lib/utils";

interface ProviderIconProps {
  src: string;
  alt?: string;
  className?: string;
}

/**
 * Renders a provider icon with theme-adaptive contrast.
 * - drop-shadow follows the alpha channel for transparent icons
 * - subtle background handles opaque icons (white-on-white / black-on-black)
 */
export function ProviderIcon({ src, alt = "", className }: ProviderIconProps) {
  return (
    <img
      src={src}
      alt={alt}
      className={cn(
        "bg-muted/50 dark:bg-muted/50 shrink-0 rounded object-contain p-1",
        "drop-shadow-[0_0_0.5px_rgba(0,0,0,0.5)] dark:drop-shadow-[0_0_0.5px_rgba(255,255,255,0.6)]",
        className,
      )}
    />
  );
}
