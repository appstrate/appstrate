// SPDX-License-Identifier: Apache-2.0

import { Puzzle } from "lucide-react";
import { parseIcon } from "@appstrate/core/appearance";
import type { PackageType } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { ManifestGlyph } from "@appstrate/ui/components/manifest-glyph";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";

const BOX = { sm: "size-7 rounded-md", md: "size-10 rounded-[10px]" } as const;

type PackageIconSize = keyof typeof BOX;

type PackageIconProps = {
  /** An agent's display name, whose initials stand in for a glyph that cannot load. */
  name?: string;
  icon?: string | null;
  color?: string | null;
  size?: PackageIconSize;
  className?: string;
} & (
  | {
      type: "agent";
      /** The package id: what an agent's derived colour is drawn from. */
      id: string;
    }
  // Unread: accepted so a caller holding any `PackageType` can pass its id.
  | { type: Exclude<PackageType, "agent">; id?: string }
);

/**
 * A package's identity tile, the same for every type and surface. Its manifest
 * `icon` follows one grammar for every type (`@appstrate/core/appearance`):
 * an agent is an `IdentityTile` (its colour, derived from its package `id` when
 * it chose none; `lucide:bot` when it has no icon), an integration shows its
 * logo (a neutral placeholder when it has none), the other types show their
 * type's glyph on a muted ground.
 */
export function PackageIcon(props: PackageIconProps) {
  const { type, name, icon, color, size = "md", className } = props;
  const box = cn(BOX[size], className);
  const muted = cn("bg-muted text-muted-foreground flex shrink-0 items-center justify-center", box);
  const mutedGlyph = size === "sm" ? "size-4" : "size-5";

  if (props.type === "agent") {
    return (
      <IdentityTile
        icon={icon}
        color={color}
        seed={props.id}
        label={name ?? props.id}
        fallbackIcon="lucide:bot"
        className={box}
      />
    );
  }

  if (type === "integration") {
    const placeholder = (
      <span className={muted} aria-hidden>
        <Puzzle className={mutedGlyph} />
      </span>
    );
    const parsed = parseIcon(icon);
    if (!parsed) return placeholder;
    return (
      <ManifestGlyph
        icon={parsed}
        className={cn("shrink-0", box, size === "sm" ? "p-1" : "p-1.5")}
        fallback={placeholder}
      />
    );
  }

  const Glyph = PACKAGE_TYPE_ICON[type];
  return (
    <span className={muted} aria-hidden>
      <Glyph className={mutedGlyph} />
    </span>
  );
}
