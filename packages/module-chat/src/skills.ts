// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects. Pure: the result sits in the system
// prompt's single `cache_control` block.

import { z } from "zod";
import type { ChatSkillMode } from "@appstrate/db/schema";
import type { InjectedSkill, InjectedSkills } from "@appstrate/core/chat-contract";

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

/** Characters the SKILL.md bodies injected into one chat turn share, out of the skills the user chose. */
export const CHAT_SKILLS_CONTENT_BUDGET_CHARS = 64_000;

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

export function isDefaultSkillSelection(selection: ChatSkillSelection): boolean {
  return (
    selection.skillMode === DEFAULT_SKILL_SELECTION.skillMode && selection.pinnedSkills.length === 0
  );
}

/** `manual` and `strict` inject the chosen skills; `auto` lists the space's. */
export function injectsSkills(mode: ChatSkillMode): boolean {
  return mode !== "auto";
}

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
  if (!injectsSkills(selection.skillMode)) return resolved;
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
