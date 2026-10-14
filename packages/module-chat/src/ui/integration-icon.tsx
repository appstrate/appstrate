// SPDX-License-Identifier: Apache-2.0

/**
 * Small integration brand icon for the chat. `src` is a manifest `icon`, read
 * by `@appstrate/core/manifest-icon`: a Lucide id drawn from the bundle, any
 * other Iconify id fetched on demand from the Iconify API, or an image URL.
 * Falls back to a neutral puzzle glyph when absent or not drawable.
 * A trimmed-down sibling of apps/web's PackageIcon (module can't import web).
 */

import { Icon } from "@iconify/react";
import { PuzzleIcon } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { parseManifestIcon } from "@appstrate/core/manifest-icon";

const LUCIDE_NAMES = new Set<string>(iconNames);

function isLucideName(name: string): name is IconName {
  return LUCIDE_NAMES.has(name);
}

export function IntegrationIcon({
  src,
  className = "size-4",
}: {
  src?: string;
  className?: string;
}) {
  const icon = parseManifestIcon(src);
  if (!icon) return <PuzzleIcon className={className} />;
  if (icon.kind === "url") {
    return <img src={icon.src} alt="" className={`${className} object-contain`} />;
  }
  if (icon.kind === "lucide") {
    return isLucideName(icon.name) ? (
      <DynamicIcon name={icon.name} className={className} />
    ) : (
      <PuzzleIcon className={className} />
    );
  }
  return <Icon icon={icon.id} className={className} />;
}
