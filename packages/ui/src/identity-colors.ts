// SPDX-License-Identifier: Apache-2.0

import type { AppearanceColor } from "@appstrate/core/appearance";

/**
 * The tile classes of each identity colour: a hue's glyph on a 20 % tint of
 * itself (`--identity-<key>` in `apps/web/src/styles.css`), `neutral` on the
 * muted surface. Every string is spelled out whole so Tailwind sees it.
 */
export const IDENTITY_COLOR_CLASSES: Record<AppearanceColor, string> = {
  neutral: "bg-muted text-muted-foreground",
  blue: "bg-identity-blue/20 text-identity-blue",
  emerald: "bg-identity-emerald/20 text-identity-emerald",
  violet: "bg-identity-violet/20 text-identity-violet",
  amber: "bg-identity-amber/20 text-identity-amber",
  rose: "bg-identity-rose/20 text-identity-rose",
  cyan: "bg-identity-cyan/20 text-identity-cyan",
  pink: "bg-identity-pink/20 text-identity-pink",
  orange: "bg-identity-orange/20 text-identity-orange",
};
