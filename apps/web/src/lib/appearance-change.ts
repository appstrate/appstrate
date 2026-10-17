// SPDX-License-Identifier: Apache-2.0

import { APPEARANCE_COLORS, type AppearanceColor } from "@appstrate/core/appearance";

/** The colour radio's value for `color: null` (derived from the entity id). */
export const AUTO_COLOR = "auto";

/** The colour radio's value as a change: a palette key, or `null` for « Automatique » (or any unknown value). */
export function colorChange(radioValue: string): { color: AppearanceColor | null } {
  return { color: APPEARANCE_COLORS.find((color) => color === radioValue) ?? null };
}
