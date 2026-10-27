// SPDX-License-Identifier: Apache-2.0

import type { AppearanceColor } from "@appstrate/core/appearance";

/**
 * The tile classes of each identity colour: a 20 % tint of the hue
 * (`--identity-<key>` in `apps/web/src/styles.css`) under its foreground
 * (`--identity-<key>-foreground`, the same hue at 4.5:1 on that tint),
 * `neutral` on the muted surface. Every string is spelled out whole so
 * Tailwind sees it.
 */
export const IDENTITY_COLOR_CLASSES: Record<AppearanceColor, string> = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-identity-blue/20 text-identity-blue-foreground",
  emerald: "bg-identity-emerald/20 text-identity-emerald-foreground",
  violet: "bg-identity-violet/20 text-identity-violet-foreground",
  amber: "bg-identity-amber/20 text-identity-amber-foreground",
  rose: "bg-identity-rose/20 text-identity-rose-foreground",
  cyan: "bg-identity-cyan/20 text-identity-cyan-foreground",
  pink: "bg-identity-pink/20 text-identity-pink-foreground",
  orange: "bg-identity-orange/20 text-identity-orange-foreground",
};
