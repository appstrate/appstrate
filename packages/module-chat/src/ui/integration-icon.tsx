// SPDX-License-Identifier: Apache-2.0

/**
 * Small integration brand icon for the chat. `src` is a manifest `icon`, read
 * by `@appstrate/core/appearance`; a neutral puzzle glyph stands in when it
 * is absent or cannot be drawn.
 */

import { PuzzleIcon } from "lucide-react";
import { parseIcon } from "@appstrate/core/appearance";
import { ManifestGlyph } from "@appstrate/ui/components/manifest-glyph";

export function IntegrationIcon({
  src,
  className = "size-4",
}: {
  src?: string;
  className?: string;
}) {
  const placeholder = <PuzzleIcon className={className} />;
  const icon = parseIcon(src);
  if (!icon) return placeholder;
  return <ManifestGlyph icon={icon} className={className} fallback={placeholder} />;
}
