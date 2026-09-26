// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects. Pure: the result sits in the system
// prompt's single `cache_control` block.

import { z } from "zod";
import type { ChatSkillMode } from "@appstrate/db/schema";
import {
  CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  type EnforcedChatSkill,
} from "@appstrate/core/chat-contract";

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

/** A skill's `SKILL.md` as injected: a chosen one as `getSkill` serves it, an enforced one as published. */
export interface SkillContent {
  packageId: string;
  version: string | null;
  content: string;
}

/** Every chosen skill is injected in full on every turn: a context-budget bound. */
export const MAX_PINNED_SKILLS = 5;

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
  /** The space's, in the platform's id order: injected in every mode. */
  enforced: SkillContent[];
  /** The user's, in stored order, minus any the space already imposes. */
  chosen: SkillContent[];
  notices: string[];
}

/**
 * The skills to inject. The space's come first and spend the shared budget
 * before the user's; a chosen skill the space already imposes is dropped
 * silently. `contents` holds only the chosen skills that are active here and
 * whose `SKILL.md` was read (sorted and deduped by the one writer,
 * `ensureSession`); any other becomes a notice.
 */
export function resolveChatSkills(
  selection: ChatSkillSelection,
  contents: ReadonlyMap<string, SkillContent>,
  enforced: readonly EnforcedChatSkill[],
): ResolvedChatSkills {
  const resolved: ResolvedChatSkills = { enforced: [], chosen: [], notices: [] };
  let left = CHAT_SKILLS_CONTENT_BUDGET_CHARS;
  const tooLong = (length: number) =>
    `(${length} characters; the injected skills share ${CHAT_SKILLS_CONTENT_BUDGET_CHARS}, ${left} left).`;
  for (const { packageId, version, content } of enforced) {
    if (content === null) {
      resolved.notices.push(
        `The skill \`${packageId}\` is required by this space but is not available here — it has no published version that can be read now.`,
      );
    } else if (content.length > left) {
      resolved.notices.push(
        `The skill \`${packageId}\` is required by this space but does not fit ${tooLong(content.length)}`,
      );
    } else {
      left -= content.length;
      resolved.enforced.push({ packageId, version, content });
    }
  }
  if (!injectsSkills(selection.skillMode)) return resolved;
  const imposedIds = new Set(enforced.map((skill) => skill.packageId));
  // A chosen skill is the user's own act, so the model is told when it is left out.
  for (const id of selection.pinnedSkills.filter((pinned) => !imposedIds.has(pinned))) {
    const skill = contents.get(id);
    if (!skill) {
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
