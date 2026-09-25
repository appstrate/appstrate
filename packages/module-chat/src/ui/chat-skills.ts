// SPDX-License-Identifier: Apache-2.0

/** The pure rules the skill picker applies to the conversation's selection. */

import type { SkillHint } from "../skills.ts";

/** Pin/unpin, sorted. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): readonly string[] {
  const set = new Set(pinned);
  if (set.has(packageId)) set.delete(packageId);
  else set.add(packageId);
  return [...set].sort();
}

/** A picker row; `available: false` is a pin the catalogue no longer lists. */
export interface SkillPickerRow {
  skill: SkillHint;
  available: boolean;
}

/** The catalogue, then every pin missing from it, so a dead pin can still be removed. */
export function skillPickerRows(
  catalogue: readonly SkillHint[],
  pinned: readonly string[],
): SkillPickerRow[] {
  const listed = new Set(catalogue.map((skill) => skill.packageId));
  const dead = pinned.filter((id) => !listed.has(id));
  return [
    ...catalogue.map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({ skill: { packageId: id }, available: false })),
  ];
}
