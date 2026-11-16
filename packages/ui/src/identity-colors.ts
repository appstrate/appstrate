// SPDX-License-Identifier: Apache-2.0

import type { AppearanceColor } from "@appstrate/core/appearance";

/**
 * The tile classes of each identity colour: the hue (`--identity-<key>` in
 * `apps/web/src/styles.css`) mixed at 20 % into the page background, under
 * its foreground (`--identity-<key>-foreground`, the same hue at 4.5:1 on
 * that tint), `neutral` on the muted surface. Mixed rather than translucent,
 * so a tile is opaque: one laid over another (a badge) does not show it
 * through. Every string is spelled out whole so Tailwind sees it.
 */
export const IDENTITY_COLOR_CLASSES: Record<AppearanceColor, string> = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-[color-mix(in_oklab,var(--identity-blue)_20%,var(--background))] text-identity-blue-foreground",
  emerald:
    "bg-[color-mix(in_oklab,var(--identity-emerald)_20%,var(--background))] text-identity-emerald-foreground",
  violet:
    "bg-[color-mix(in_oklab,var(--identity-violet)_20%,var(--background))] text-identity-violet-foreground",
  amber:
    "bg-[color-mix(in_oklab,var(--identity-amber)_20%,var(--background))] text-identity-amber-foreground",
  rose: "bg-[color-mix(in_oklab,var(--identity-rose)_20%,var(--background))] text-identity-rose-foreground",
  cyan: "bg-[color-mix(in_oklab,var(--identity-cyan)_20%,var(--background))] text-identity-cyan-foreground",
  pink: "bg-[color-mix(in_oklab,var(--identity-pink)_20%,var(--background))] text-identity-pink-foreground",
  orange:
    "bg-[color-mix(in_oklab,var(--identity-orange)_20%,var(--background))] text-identity-orange-foreground",
};
