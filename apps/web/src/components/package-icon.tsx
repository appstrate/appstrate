// SPDX-License-Identifier: Apache-2.0

import { Puzzle } from "lucide-react";
import { parseIcon } from "@appstrate/core/appearance";
import type { PackageType } from "@appstrate/shared-types";
import { cn } from "@appstrate/ui/cn";
import { IdentityTile } from "@appstrate/ui/components/identity-tile";
import { ManifestGlyph } from "@appstrate/ui/components/manifest-glyph";
import { PACKAGE_TYPE_ICON } from "../lib/package-type-icon";

/** `xs` sits inline beside a line of text, `sm` in a compact row, `md` on a card. */
const BOX = {
  xs: "size-4 rounded-sm",
  sm: "size-7 rounded-md",
  md: "size-10 rounded-[10px]",
} as const;
const GLYPH_PADDING = { xs: "p-0", sm: "p-1", md: "p-1.5" } as const;

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
 * logo on a white ground of its own (a neutral placeholder when it has none),
 * the other types show their type's glyph on a muted ground.
 */
export function PackageIcon(props: PackageIconProps) {
  const { type, name, icon, color, size = "md", className } = props;
  const box = cn(BOX[size], className);
  const muted = cn("bg-muted text-muted-foreground flex shrink-0 items-center justify-center", box);
  const mutedGlyph = { xs: "size-3", sm: "size-4", md: "size-5" }[size];

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
    // A logo is a brand's glyph, transparent and drawn for a light surface: a black one vanishes
    // on the dark theme. It sits on a white ground of its own, as an app icon does, which keeps
    // its colours exact on every theme (what Linear's or Raycast's catalogues do, and why app
    // directories refuse transparent icons). A glyph drawn in `currentColor` (Lucide, simple-icons)
    // takes the ground's dark ink, not the theme's text colour. A glyph that cannot be drawn leaves
    // the ground and the placeholder's puzzle on it, in a grey that reads on white.
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center bg-white text-neutral-900",
          box,
          GLYPH_PADDING[size],
        )}
      >
        <ManifestGlyph
          icon={parsed}
          className="size-full"
          fallback={<Puzzle className={cn(mutedGlyph, "text-neutral-400")} aria-hidden />}
        />
      </span>
    );
  }

  const Glyph = PACKAGE_TYPE_ICON[type];
  return (
    <span className={muted} aria-hidden>
      <Glyph className={mutedGlyph} />
    </span>
  );
}
