// SPDX-License-Identifier: Apache-2.0

// The skill pill's texts (`skill-chips.tsx`): its summary, and what its live region reads.

import { parseScopedName } from "@appstrate/core/naming";
import type { StoredSkills } from "./chat-skills.ts";
import type { ChatTranslate } from "./runtime-context.ts";

export interface LoadedSkill {
  packageId: string;
  name: string;
}

export type SkillNames = ReadonlyMap<string, string>;

export function namedSkill(names: SkillNames, id: string): LoadedSkill {
  return { packageId: id, name: names.get(id) ?? parseScopedName(id)?.name ?? id };
}

/** What the live region reads of the pins' verdicts: skills loaded, then how many were left out. `null` until `names` is known. */
export function verdictsSummary(
  skills: StoredSkills,
  names: SkillNames | null,
  t: ChatTranslate,
): string | null {
  if (!names) return null;
  const judged = skills.pins.filter((pin) => pin.status !== null);
  const loaded = judged
    .filter((pin) => pin.status === "injected")
    .map((pin) => namedSkill(names, pin.id));
  const refused = judged.length - loaded.length;
  if (loaded.length === 0) return refused === 0 ? "" : skillsSummary(loaded, refused, t);
  if (refused === 0) return skillsSummary(loaded, 0, t);
  return t("skills.liveSummary", {
    loaded: skillsSummary(loaded, 0, t),
    refused: t("skills.notLoadedCount", { count: refused }),
  });
}

/** The single skill's name, a count (`countKey` picks « pinned » or « skills »), or the not-loaded count. */
export function skillsSummary(
  skills: readonly LoadedSkill[],
  refused: number,
  t: ChatTranslate,
  countKey: "skills.count" | "skills.pinnedCount" = "skills.count",
): string {
  if (skills.length === 0) return t("skills.notLoadedCount", { count: refused });
  return skills.length === 1 ? skills[0]!.name : t(countKey, { count: skills.length });
}
