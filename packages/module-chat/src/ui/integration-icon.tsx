// SPDX-License-Identifier: Apache-2.0

/**
 * Small integration brand icon for the chat. `src` is a manifest `icon`: an
 * Iconify id (`logos:google-gmail`, fetched on demand from the Iconify API) or
 * an image URL. Falls back to a neutral puzzle glyph when absent or unresolved.
 * A trimmed-down sibling of apps/web's IntegrationIcon (module can't import web).
 */

import { Icon } from "@iconify/react";
import { PuzzleIcon } from "lucide-react";

export function IntegrationIcon({
  src,
  className = "size-4",
}: {
  src?: string;
  className?: string;
}) {
  if (!src) return <PuzzleIcon className={className} />;
  if (/^https?:\/\//.test(src)) {
    return <img src={src} alt="" className={`${className} object-contain`} />;
  }
  return <Icon icon={src} className={className} />;
}
