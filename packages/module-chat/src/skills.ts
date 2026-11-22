// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects. Pure and browser-safe: the UI imports it (src/ui/*), so no
// runtime import of the logger or any server module.

import type { InjectedSkill, InjectedSkills } from "@appstrate/core/chat-contract";
import type { ChatSkillStatus, ChatSkillStatusEntry } from "@appstrate/db/schema";

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

/** The characters the pinned skills' SKILL.md bodies may take in one turn, all skills together. */
export const CHAT_SKILLS_CONTENT_BUDGET_CHARS = 64_000;

/** Every pinned skill is injected in full on every turn: a context-budget bound. */
export const MAX_PINNED_SKILLS = 5;

/** Named as the `chat_sessions` columns, so a session row is a selection. */
export interface ChatSkillSelection {
  /** The model finds the other skills of the turn's spaces; off, the turn holds no `skills:*`. */
  skillDiscovery: boolean;
  pinnedSkills: string[];
}

export type { ChatSkillStatus };

/** A pin as the session DTOs carry it (`pins`): `null` status and `chars` until a claiming turn evaluates it. */
export interface PinnedSkill {
  id: string;
  status: ChatSkillStatus | null;
  /** Its SKILL.md length, counted against {@link CHAT_SKILLS_CONTENT_BUDGET_CHARS}, when last read. */
  chars: number | null;
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = {
  skillDiscovery: true,
  pinnedSkills: [],
};

interface ResolvedChatSkills {
  injected: SkillContent[];
  notices: string[];
  statuses: Record<string, ChatSkillStatusEntry>;
}

/** The pins to inject, in stored order, out of one budget; `contents` maps each listed pin to its read (`null`: unreadable). */
export function resolveChatSkills(
  selection: ChatSkillSelection,
  contents: ReadonlyMap<string, SkillContent | null>,
): ResolvedChatSkills {
  const resolved: ResolvedChatSkills = { injected: [], notices: [], statuses: {} };
  let left = CHAT_SKILLS_CONTENT_BUDGET_CHARS;
  const tooLong = (length: number) =>
    `(${length} characters; the injected skills share ${CHAT_SKILLS_CONTENT_BUDGET_CHARS}, ${left} left).`;
  // A pin is the user's act, so the model is told when it is left out.
  for (const id of selection.pinnedSkills) {
    const skill = contents.get(id);
    if (skill === null) {
      resolved.statuses[id] = { status: "unreadable", chars: null };
      resolved.notices.push(
        `The skill \`${id}\` is pinned to this conversation but could not be read.`,
      );
    } else if (!skill) {
      resolved.statuses[id] = { status: "unavailable", chars: null };
      resolved.notices.push(
        `The skill \`${id}\` is pinned to this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
      );
    } else if (skill.content.length > left) {
      resolved.statuses[id] = { status: "over_budget", chars: skill.content.length };
      resolved.notices.push(
        `The skill \`${id}\` is pinned to this conversation but does not fit ${tooLong(skill.content.length)}`,
      );
    } else {
      resolved.statuses[id] = { status: "injected", chars: skill.content.length };
      left -= skill.content.length;
      resolved.injected.push(skill);
    }
  }
  return resolved;
}

/**
 * What `resources/read` may serve this turn without `skills:read`: exactly the
 * definitions injected, never a skill that only got a notice.
 */
export function injectedSkills(resolved: ResolvedChatSkills): InjectedSkills["skills"] {
  return Object.fromEntries(resolved.injected.map(({ packageId, served }) => [packageId, served]));
}
