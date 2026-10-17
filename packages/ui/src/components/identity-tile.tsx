// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { parseIcon, resolveColor, type AppearanceIcon } from "@appstrate/core/appearance";
import { cn } from "../cn.ts";
import { IDENTITY_COLOR_CLASSES } from "../identity-colors.ts";
import { initials } from "../initials.ts";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar.tsx";
import { ManifestGlyph } from "./manifest-glyph.tsx";

// The tile is a size container: what it draws is sized in `cqw`/`%` of it, so a caller sizes the whole tile with one `size-*`.
function glyphClassName(icon: AppearanceIcon): string {
  return icon.kind === "emoji" ? "text-[length:55cqw]" : "size-[55%]";
}

function Glyph({ icon, fallback }: { icon: AppearanceIcon; fallback: ReactNode }) {
  return <ManifestGlyph icon={icon} className={glyphClassName(icon)} fallback={fallback} />;
}

/**
 * The visual identity of an agent, a space, an organization or a person: its
 * `icon` (any form `parseIcon` reads) on its colour (`resolveColor`, derived
 * from `seed` when none is chosen). An image covers the tile; a glyph sits
 * centred on the colour. With no drawable icon the tile shows `fallbackIcon`
 * when given, the initials of `label` otherwise — and the same stands in for an
 * unknown Lucide name, a failed Iconify fetch or a broken image (not for a
 * Lucide chunk that fails to load: that is our own bundle, and the glyph is
 * simply absent while it loads).
 *
 * Decorative: every caller writes the name next to it.
 */
export function IdentityTile({
  icon,
  color,
  seed,
  label,
  fallbackIcon,
  shape = "square",
  className,
}: {
  icon?: string | null;
  color?: string | null;
  seed: string;
  label: string;
  fallbackIcon?: string;
  shape?: "square" | "round";
  className?: string;
}) {
  const parsed = parseIcon(icon);
  const parsedFallback = parseIcon(fallbackIcon);
  const letters = (
    <span className="text-[length:40cqw] leading-none font-semibold">{initials(label)}</span>
  );
  const fallback = parsedFallback ? <Glyph icon={parsedFallback} fallback={letters} /> : letters;

  return (
    <Avatar
      aria-hidden
      className={cn(
        "@container items-center justify-center",
        shape === "square" ? "rounded-lg" : "rounded-full",
        IDENTITY_COLOR_CLASSES[resolveColor(color, seed)],
        className,
      )}
    >
      {parsed?.kind === "url" ? (
        <>
          <AvatarImage src={parsed.src} alt="" className="object-cover" />
          <AvatarFallback className="rounded-[inherit] bg-transparent">{fallback}</AvatarFallback>
        </>
      ) : parsed ? (
        <Glyph icon={parsed} fallback={fallback} />
      ) : (
        fallback
      )}
    </Avatar>
  );
}
