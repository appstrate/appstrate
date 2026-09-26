// SPDX-License-Identifier: Apache-2.0

// Which chosen skills a chat turn injects. Pure: the result sits in the system
// prompt's single `cache_control` block.

import { z } from "zod";
import type { ChatSkillMode } from "@appstrate/db/schema";

export interface SkillHint {
  packageId: string;
  display_name?: string | null;
  description?: string | null;
  version?: string | null;
}

/** The fields read off a row of `GET /api/packages/skills`. */
const skillListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  version: z.string().nullable(),
});

/**
 * `GET /api/packages/skills`: the space's ACTIVE skills, uncapped — what the
 * picker offers, and what a chosen skill must be in to be injected. A malformed
 * row is dropped.
 */
export function parseSkillList(body: unknown): SkillHint[] {
  const data = (body as { data?: unknown } | null)?.data;
  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const parsed = skillListRowSchema.safeParse(row);
    if (!parsed.success) return [];
    const { id, name, description, version } = parsed.data;
    return [{ packageId: id, display_name: name, description, version }];
  });
}

/** A chosen skill's `SKILL.md`, as `getSkill` serves it to the caller. */
export interface SkillContent {
  packageId: string;
  version: string | null;
  content: string;
}

/** Every chosen skill is injected in full on every turn: a context-budget bound. */
export const MAX_PINNED_SKILLS = 5;

/**
 * Characters the injected `SKILL.md`s share, spent in stored order: what weighs
 * on the context is the sum, not one skill. One that does not fit what is left
 * is left out with a notice; a later, smaller one may still fit.
 */
export const SKILLS_CONTENT_BUDGET_CHARS = 64_000;

/** Named as the `chat_sessions` columns, so a session row is a selection. */
export interface ChatSkillSelection {
  skillMode: ChatSkillMode;
  /** Injected in `manual` and `strict`; kept but unused in `auto`. */
  pinnedSkills: string[];
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = {
  skillMode: "auto",
  pinnedSkills: [],
};

/** `manual` and `strict` inject the chosen skills; `auto` lists the space's. */
export function injectsSkills(mode: ChatSkillMode): boolean {
  return mode !== "auto";
}

interface ResolvedChatSkills {
  injected: SkillContent[];
  notices: string[];
}

/**
 * The chosen skills to inject, in their stored order (sorted and deduped by the
 * one writer, `ensureSession`). `contents` holds only the chosen skills that are
 * active here and whose `SKILL.md` was read; any other becomes a notice.
 */
export function resolveChatSkills(
  selection: ChatSkillSelection,
  contents: ReadonlyMap<string, SkillContent>,
): ResolvedChatSkills {
  const injected: SkillContent[] = [];
  // A chosen skill is the user's own act, so the model is told when it is left out.
  const notices: string[] = [];
  if (!injectsSkills(selection.skillMode)) return { injected, notices };
  let left = SKILLS_CONTENT_BUDGET_CHARS;
  for (const id of selection.pinnedSkills) {
    const skill = contents.get(id);
    if (!skill) {
      notices.push(
        `The skill \`${id}\` was chosen for this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
      );
    } else if (skill.content.length > left) {
      notices.push(
        `The skill \`${id}\` was chosen for this conversation but does not fit (${skill.content.length} characters; the chosen skills share ${SKILLS_CONTENT_BUDGET_CHARS}, ${left} left).`,
      );
    } else {
      left -= skill.content.length;
      injected.push(skill);
    }
  }
  return { injected, notices };
}
