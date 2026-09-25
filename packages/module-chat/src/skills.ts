// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn shows the model. Pure and order-independent: the
// result sits in the system prompt's single `cache_control` block.

import type { ChatSkillMode } from "@appstrate/db/schema";

export type { ChatSkillMode };

export interface SkillHint {
  packageId: string;
  display_name?: string | null;
  description?: string | null;
  version?: string | null;
}

/** A chosen skill's `SKILL.md`, as `getSkill` serves it to the caller. */
export interface SkillContent {
  packageId: string;
  version: string | null;
  content: string;
}

/** Every chosen skill is injected in full on every turn: a context-budget bound. */
export const MAX_PINNED_SKILLS = 5;

/** Characters of one injected `SKILL.md`; a longer one is left out with a notice. */
export const MAX_SKILL_CONTENT_CHARS = 16_000;

/** Named as the `chat_sessions` columns, so a session row is a selection. */
export interface ChatSkillSelection {
  skillMode: ChatSkillMode;
  /** Injected in `manual` and `strict`; kept but unused in `auto`. */
  pinnedSkills: readonly string[];
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = {
  skillMode: "auto",
  pinnedSkills: [],
};

/** `manual` and `strict` inject the chosen skills; `auto` lists the space's. */
export function injectsSkills(mode: ChatSkillMode): boolean {
  return mode !== "auto";
}

export interface ResolveChatSkillsInput {
  selection: ChatSkillSelection;
  /** `/api/me/context` `requested_skills`: the chosen skills active in this space. */
  requested: readonly SkillHint[];
  /** The chosen skills' content by package id; a failed read is absent. */
  contents: ReadonlyMap<string, SkillContent>;
  /** `/api/me/context` `skills`: the space's listing, capped. */
  catalogue: readonly SkillHint[];
  catalogueTruncated: boolean;
}

interface ResolvedChatSkills {
  injected: SkillContent[];
  catalogue: SkillHint[];
  catalogueTruncated: boolean;
  notices: string[];
}

export function resolveChatSkills(input: ResolveChatSkillsInput): ResolvedChatSkills {
  const { selection } = input;
  if (!injectsSkills(selection.skillMode)) {
    return {
      injected: [],
      catalogue: [...input.catalogue],
      catalogueTruncated: input.catalogueTruncated,
      notices: [],
    };
  }

  const active = new Set(input.requested.map((hint) => hint.packageId));
  const injected: SkillContent[] = [];
  // A chosen skill is the user's own act, so the model is told when it is left out.
  const notices: string[] = [];
  for (const id of [...new Set(selection.pinnedSkills)].sort()) {
    const skill = input.contents.get(id);
    if (!active.has(id) || !skill) {
      notices.push(
        `The skill \`${id}\` was chosen for this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
      );
    } else if (skill.content.length > MAX_SKILL_CONTENT_CHARS) {
      notices.push(
        `The skill \`${id}\` was chosen for this conversation but is too long to include (${skill.content.length} characters, limit ${MAX_SKILL_CONTENT_CHARS}).`,
      );
    } else {
      injected.push(skill);
    }
  }
  return { injected, catalogue: [], catalogueTruncated: false, notices };
}
