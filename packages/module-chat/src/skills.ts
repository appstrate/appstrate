// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects. Pure: the result sits in the system
// prompt's single `cache_control` block.

import type { InjectedSkill, InjectedSkills } from "@appstrate/core/chat-contract";

/** A skill's `SKILL.md` as injected: as the MCP Skills extension serves it at `uri`. */
export interface SkillContent {
  packageId: string;
  version: string | null;
  /** The `skill://` URI of its `SKILL.md`; a file of the skill sits next to it. */
  uri: string;
  content: string;
  /** Its claim entry: what `resources/read` serves this turn. */
  served: InjectedSkill;
}

/** The characters the chosen skills' SKILL.md bodies may take in one turn, all skills together. */
export const CHAT_SKILLS_CONTENT_BUDGET_CHARS = 64_000;

/** Every chosen skill is injected in full on every turn: a context-budget bound. */
export const MAX_PINNED_SKILLS = 5;

/** Named as the `chat_sessions` columns, so a session row is a selection. */
export interface ChatSkillSelection {
  /** The model finds the other skills of the turn's spaces; off, the turn holds no `skills:*`. */
  skillDiscovery: boolean;
  /** Injected in full on every turn, whatever `skillDiscovery`. */
  pinnedSkills: string[];
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = {
  skillDiscovery: true,
  pinnedSkills: [],
};

interface ResolvedChatSkills {
  chosen: SkillContent[];
  notices: string[];
}

/**
 * The skills to inject: the chosen ones in stored order (sorted and deduped by
 * `ensureSession`), out of one budget. `contents` holds the chosen skills active
 * here and read (`null`: answered malformed); any other becomes a notice.
 */
export function resolveChatSkills(
  selection: ChatSkillSelection,
  contents: ReadonlyMap<string, SkillContent | null>,
): ResolvedChatSkills {
  const resolved: ResolvedChatSkills = { chosen: [], notices: [] };
  let left = CHAT_SKILLS_CONTENT_BUDGET_CHARS;
  const tooLong = (length: number) =>
    `(${length} characters; the injected skills share ${CHAT_SKILLS_CONTENT_BUDGET_CHARS}, ${left} left).`;
  // A chosen skill is the user's own act, so the model is told when it is left out.
  for (const id of selection.pinnedSkills) {
    const skill = contents.get(id);
    if (skill === null) {
      resolved.notices.push(
        `The skill \`${id}\` was chosen for this conversation but could not be read.`,
      );
    } else if (!skill) {
      resolved.notices.push(
        `The skill \`${id}\` was chosen for this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
      );
    } else if (skill.content.length > left) {
      resolved.notices.push(
        `The skill \`${id}\` was chosen for this conversation but does not fit ${tooLong(skill.content.length)}`,
      );
    } else {
      left -= skill.content.length;
      resolved.chosen.push(skill);
    }
  }
  return resolved;
}

/**
 * What `resources/read` may serve this turn without `skills:read`: exactly the
 * definitions injected, never a skill that only got a notice.
 */
export function injectedSkills(resolved: ResolvedChatSkills): InjectedSkills["skills"] {
  return Object.fromEntries(resolved.chosen.map(({ packageId, served }) => [packageId, served]));
}
