// SPDX-License-Identifier: Apache-2.0

import type { AppearanceColor } from "@appstrate/core/appearance";

/**
 * The tile classes of each identity colour: the tile (`--color-identity-<key>-tile`
 * in `apps/web/src/styles.css`, the hue mixed at 20 % into the page background, so
 * a tile laid over another, a badge, does not show it through) under its foreground
 * (`--identity-<key>-foreground`, the same hue at 4.5:1 on that tint), `neutral`
 * on the muted surface. Every string is spelled out whole so Tailwind sees it.
 */
export const IDENTITY_COLOR_CLASSES: Record<AppearanceColor, string> = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-identity-blue-tile text-identity-blue-foreground",
  emerald: "bg-identity-emerald-tile text-identity-emerald-foreground",
  violet: "bg-identity-violet-tile text-identity-violet-foreground",
  amber: "bg-identity-amber-tile text-identity-amber-foreground",
  rose: "bg-identity-rose-tile text-identity-rose-foreground",
  cyan: "bg-identity-cyan-tile text-identity-cyan-foreground",
  pink: "bg-identity-pink-tile text-identity-pink-foreground",
  orange: "bg-identity-orange-tile text-identity-orange-foreground",
};

/**
 * A surface tinted by an identity colour (a run's card in the chat): the colour's tile token as a
 * light veil over what lies under it, raised one step while its `button` child is hovered, a
 * hairline of the same hue; `badge` fills a badge laid on it with the opaque tile, as a tile's
 * corner reads. `neutral` is a muted veil on the default border. Spelled out whole for Tailwind.
 */
export const IDENTITY_SURFACE_CLASSES: Record<AppearanceColor, { surface: string; badge: string }> =
  {
    neutral: {
      surface: "bg-muted/40 has-[>button:hover]:bg-muted/70",
      badge: "bg-muted",
    },
    blue: {
      surface:
        "border-identity-blue-foreground/20 bg-identity-blue-tile/50 has-[>button:hover]:bg-identity-blue-tile/80",
      badge: "bg-identity-blue-tile",
    },
    emerald: {
      surface:
        "border-identity-emerald-foreground/20 bg-identity-emerald-tile/50 has-[>button:hover]:bg-identity-emerald-tile/80",
      badge: "bg-identity-emerald-tile",
    },
    violet: {
      surface:
        "border-identity-violet-foreground/20 bg-identity-violet-tile/50 has-[>button:hover]:bg-identity-violet-tile/80",
      badge: "bg-identity-violet-tile",
    },
    amber: {
      surface:
        "border-identity-amber-foreground/20 bg-identity-amber-tile/50 has-[>button:hover]:bg-identity-amber-tile/80",
      badge: "bg-identity-amber-tile",
    },
    rose: {
      surface:
        "border-identity-rose-foreground/20 bg-identity-rose-tile/50 has-[>button:hover]:bg-identity-rose-tile/80",
      badge: "bg-identity-rose-tile",
    },
    cyan: {
      surface:
        "border-identity-cyan-foreground/20 bg-identity-cyan-tile/50 has-[>button:hover]:bg-identity-cyan-tile/80",
      badge: "bg-identity-cyan-tile",
    },
    pink: {
      surface:
        "border-identity-pink-foreground/20 bg-identity-pink-tile/50 has-[>button:hover]:bg-identity-pink-tile/80",
      badge: "bg-identity-pink-tile",
    },
    orange: {
      surface:
        "border-identity-orange-foreground/20 bg-identity-orange-tile/50 has-[>button:hover]:bg-identity-orange-tile/80",
      badge: "bg-identity-orange-tile",
    },
  };
