// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects. Pure: the result sits in the system
// prompt's single `cache_control` block.

import { z } from "zod";
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

/** Why a turn left a pinned skill out of its context; `injected` when it did not. */
export const PINNED_SKILL_STATUSES = [
  "injected",
  "over_budget",
  "unavailable",
  "unreadable",
] as const;
export type PinnedSkillStatus = (typeof PINNED_SKILL_STATUSES)[number];

/** Who pinned a skill: the user (panel, `/` citation) or the assistant (loading its `SKILL.md`). */
export type PinnedSkillSource = "user" | "assistant";

/**
 * A pin as the session DTOs carry it (`skills`). `status` is the verdict of the last turn that
 * claimed the conversation; `null` until a turn evaluates the pin.
 */
export interface PinnedSkill {
  id: string;
  source: PinnedSkillSource;
  status: PinnedSkillStatus | null;
}

/**
 * What a turn changes in the stored selection (`skill_discovery`, `pin_skills`, `unpin_skills` on
 * `POST /chat`): deltas against the server's state, never a full set, so a stale client cannot
 * drop a pin the server added.
 */
export interface ChatSkillChanges {
  skillDiscovery?: boolean;
  pin: readonly string[];
  unpin: readonly string[];
}

/** `pinned` after `changes`: unpins out, pins in, sorted and deduped. The server applies the same rule in SQL. */
export function applySkillChanges(
  pinned: readonly string[],
  changes: Pick<ChatSkillChanges, "pin" | "unpin">,
): string[] {
  const unpin = new Set(changes.unpin);
  return [...new Set([...pinned.filter((id) => !unpin.has(id)), ...changes.pin])].sort();
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = {
  skillDiscovery: true,
  pinnedSkills: [],
};

interface ResolvedChatSkills {
  chosen: SkillContent[];
  notices: string[];
  /** Each pin's verdict, in stored order: what the turn's claim writes to `skill_status`. */
  statuses: Record<string, PinnedSkillStatus>;
  /** The characters of the shared budget the chosen skills leave: what an assistant load may take. */
  left: number;
}

/**
 * The skills to inject: the chosen ones in stored order (sorted and deduped by
 * `ensureSession`), out of one budget. `contents` holds the chosen skills found here: read, or
 * `null` when their read failed or answered malformed; a skill absent from it is in no listing.
 */
export function resolveChatSkills(
  selection: ChatSkillSelection,
  contents: ReadonlyMap<string, SkillContent | null>,
): ResolvedChatSkills {
  const resolved: ResolvedChatSkills = {
    chosen: [],
    notices: [],
    statuses: {},
    left: CHAT_SKILLS_CONTENT_BUDGET_CHARS,
  };
  const tooLong = (length: number) =>
    `(${length} characters; the injected skills share ${CHAT_SKILLS_CONTENT_BUDGET_CHARS}, ${resolved.left} left).`;
  // A pin is the user's act or the assistant's earlier load, so the model is told when it is left out.
  for (const id of selection.pinnedSkills) {
    const skill = contents.get(id);
    if (skill === null) {
      resolved.statuses[id] = "unreadable";
      resolved.notices.push(
        `The skill \`${id}\` is pinned to this conversation but could not be read.`,
      );
    } else if (!skill) {
      resolved.statuses[id] = "unavailable";
      resolved.notices.push(
        `The skill \`${id}\` is pinned to this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
      );
    } else if (skill.content.length > resolved.left) {
      resolved.statuses[id] = "over_budget";
      resolved.notices.push(
        `The skill \`${id}\` is pinned to this conversation but does not fit ${tooLong(skill.content.length)}`,
      );
    } else {
      resolved.statuses[id] = "injected";
      resolved.left -= skill.content.length;
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

const pinnedSkillStatusSchema = z.enum(PINNED_SKILL_STATUSES);

/** The pins of a session row as its DTOs carry them (`skills`), sorted by id. */
export function pinnedSkillsOf(row: {
  pinnedSkills: readonly string[];
  assistantSkills: readonly string[];
  skillStatus: Readonly<Record<string, unknown>>;
}): PinnedSkill[] {
  const assistant = new Set(row.assistantSkills);
  return [...row.pinnedSkills].sort().map((id) => {
    const status = pinnedSkillStatusSchema.safeParse(row.skillStatus[id]);
    return {
      id,
      source: assistant.has(id) ? "assistant" : "user",
      status: status.success ? status.data : null,
    };
  });
}

/** What pinning a skill the assistant loads answered (`pinAssistantSkill`). */
export type SkillPinOutcome = "pinned" | "full" | "released";

/**
 * The assistant's read of a skill file `uri` that answered `text`, in a persisted turn. True when
 * it is the `SKILL.md` this conversation injects for its skill (the URI the turn's listing gives)
 * and the skill is now a pin: injected already (system prompt, or an earlier load), or pinned by
 * this read, so later turns inject it from the system prompt. False for any other read, which
 * stays a plain one. Throws the refusal the model reads, with nothing marked, when the text does
 * not fit the budget the turn has left, the conversation already pins {@link MAX_PINNED_SKILLS}
 * skills, or the turn no longer holds the conversation.
 */
export type SkillLoad = (uri: string, text: string) => Promise<boolean>;

const refusalLead = (packageId: string) => `The skill \`${packageId}\` was not loaded:`;
const PIN_REFUSALS: Record<Exclude<SkillPinOutcome, "pinned">, (packageId: string) => string> = {
  full: (packageId) =>
    `${refusalLead(packageId)} this conversation already pins ${MAX_PINNED_SKILLS} skills, the most it holds. Nothing was pinned. Tell the user: they can unpin a skill in the skills panel of the composer, then ask again.`,
  released: (packageId) =>
    `${refusalLead(packageId)} this turn no longer holds the conversation (it was stopped or another turn started). Nothing was pinned.`,
};

/**
 * The turn's {@link SkillLoad}. `uris` maps each skill the turn can see to the `SKILL.md` URI its
 * injection would use; `injected` and `budgetLeft` are what the system prompt injected and left.
 * A load reserves its share of the budget before `pin` is awaited, and a parallel read of the
 * same skill waits for that load, so concurrent tool calls never spend the budget twice; a
 * refused pin gives the reservation back.
 */
export function turnSkillLoad(opts: {
  uris: ReadonlyMap<string, string>;
  injected: Iterable<string>;
  budgetLeft: number;
  pin: (packageId: string) => Promise<SkillPinOutcome>;
}): SkillLoad {
  const loads = new Map<string, Promise<void>>(
    [...opts.injected].map((id) => [id, Promise.resolve()]),
  );
  let left = opts.budgetLeft;
  return async (uri, text) => {
    const packageId = [...opts.uris].find(([, injectedAt]) => injectedAt === uri)?.[0];
    if (packageId === undefined) return false;
    const pending = loads.get(packageId);
    if (pending) {
      await pending;
      return true;
    }
    if (text.length > left) {
      throw new Error(
        `${refusalLead(packageId)} its SKILL.md (${text.length} characters) does not fit the ${left} characters left of the ${CHAT_SKILLS_CONTENT_BUDGET_CHARS} the conversation's skills share. Nothing was pinned. Tell the user: they can unpin a skill in the skills panel of the composer to make room.`,
      );
    }
    left -= text.length;
    const load = opts.pin(packageId).then((outcome) => {
      if (outcome !== "pinned") throw new Error(PIN_REFUSALS[outcome](packageId));
    });
    loads.set(packageId, load);
    try {
      await load;
    } catch (error) {
      left += text.length;
      loads.delete(packageId);
      throw error;
    }
    return true;
  };
}
