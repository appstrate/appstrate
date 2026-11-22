// SPDX-License-Identifier: Apache-2.0

/** The skill picker's pure rules. */

import { parseScopedName } from "@appstrate/core/naming";
import type { ChatSkillCommand } from "../commands.ts";
import { SKILL_DIRECTIVE, directivesOf } from "../directives.ts";
import { MAX_PINNED_SKILLS, type ChatSkillSelection } from "../skills.ts";

/** The package ids of the skills a draft cites with a skill directive, each once. */
export function citedSkillIds(draft: string): string[] {
  return [
    ...new Set(directivesOf(draft).flatMap((d) => (d.type === SKILL_DIRECTIVE ? [d.id] : []))),
  ];
}

/**
 * Whether restoring the default selection changes anything the user can see: a pinned skill the
 * draft does not cite (a cited one stays checked by its chip), or discovery off.
 */
export function canResetSkills(selection: ChatSkillSelection, cited: readonly string[]): boolean {
  return !selection.skillDiscovery || selection.pinnedSkills.some((id) => !cited.includes(id));
}

/**
 * The skills the conversation will load: the pinned ones and those the draft cites (sending pins
 * them). The ONE place the pin cap is counted: the panel, the pill, the `/` menu and the send all
 * read it.
 */
export function effectiveSkills(pinned: readonly string[], cited: readonly string[]) {
  const ids = [...new Set([...pinned, ...cited])];
  return {
    ids,
    /** Cited in the draft: the composer holds them, the panel cannot uncheck them. */
    cited: new Set(cited),
    atCap: ids.length >= MAX_PINNED_SKILLS,
    overCap: ids.length > MAX_PINNED_SKILLS,
  };
}

/** Pin/unpin. The picker disables a new pin at the cap; the route refuses one past it. */
export function togglePinned(pinned: readonly string[], packageId: string): string[] {
  return pinned.includes(packageId)
    ? pinned.filter((id) => id !== packageId)
    : [...pinned, packageId];
}

/**
 * A choosable picker row: the catalogue, then every pin missing from it
 * (`available: false`, named by its package's bare name), so a dead pin can
 * still be removed.
 */
export function skillPickerRows(
  catalogue: readonly ChatSkillCommand[],
  pinned: readonly string[],
): { skill: ChatSkillCommand; available: boolean }[] {
  const listed = new Set(catalogue.map((skill) => skill.id));
  const dead = pinned.filter((id) => !listed.has(id));
  return [
    ...catalogue.map((skill) => ({ skill, available: true })),
    ...dead.map((id) => ({
      skill: {
        id,
        name: parseScopedName(id)?.name ?? id,
        description: "",
        version: null,
      },
      available: false,
    })),
  ];
}
