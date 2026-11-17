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
