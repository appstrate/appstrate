// SPDX-License-Identifier: Apache-2.0

/** The skill picker's data and pure rules. */

import { parseSkillList, type SkillHint } from "../skills.ts";
import type { GetHeaders } from "./runtime-context.ts";

/** The space's active skills, the ones the picker chooses from. */
export async function fetchSkills(getHeaders: GetHeaders | null | undefined): Promise<SkillHint[]> {
  const res = await fetch("/api/packages/skills", {
    credentials: "include",
    headers: { ...getHeaders?.() },
  });
  if (!res.ok) throw new Error(`Failed to load skills (HTTP ${res.status})`);
  return parseSkillList(await res.json());
}

/** Pin/unpin. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  return pinned.includes(packageId)
    ? pinned.filter((id) => id !== packageId)
    : [...pinned, packageId];
}

/**
 * A picker row: the catalogue, then every pin missing from it (`available:
 * false`), so a dead pin can still be removed.
 */
export function skillPickerRows(
  catalogue: readonly SkillHint[],
  pinned: readonly string[],
): { skill: SkillHint; available: boolean }[] {
  const listed = new Set(catalogue.map((skill) => skill.packageId));
  const dead = pinned.filter((id) => !listed.has(id));
  return [
    ...catalogue.map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({ skill: { packageId: id }, available: false })),
  ];
}
