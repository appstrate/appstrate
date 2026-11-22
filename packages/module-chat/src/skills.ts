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
 * `ensureSession`), out of one budget. `contents` holds the chosen skills active
 * here and read (`null`: answered malformed); any other becomes a notice.
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
  // A pinned skill is the user's own act or an earlier load, so the model is told when it is left out.
  for (const id of selection.pinnedSkills) {
    const skill = contents.get(id);
    if (skill === null) {
      resolved.statuses[id] = "unreadable";
      resolved.notices.push(
        `The skill \`${id}\` was chosen for this conversation but could not be read.`,
      );
    } else if (!skill) {
      resolved.statuses[id] = "unavailable";
      resolved.notices.push(
        `The skill \`${id}\` was chosen for this conversation but is not available here — it may have been removed, deactivated, or be out of your reach.`,
      );
    } else if (skill.content.length > resolved.left) {
      resolved.statuses[id] = "over_budget";
      resolved.notices.push(
        `The skill \`${id}\` was chosen for this conversation but does not fit ${tooLong(skill.content.length)}`,
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

/** The pins of a session row as its DTOs carry them (`skills`), sorted by id. */
export function pinnedSkillsOf(row: {
  pinnedSkills: readonly string[];
  assistantSkills: readonly string[];
  skillStatus: Readonly<Record<string, string>>;
}): PinnedSkill[] {
  const assistant = new Set(row.assistantSkills);
  return [...row.pinnedSkills].sort().map((id) => {
    const status = row.skillStatus[id];
    return {
      id,
      source: assistant.has(id) ? "assistant" : "user",
      status: (PINNED_SKILL_STATUSES as readonly string[]).includes(status ?? "")
        ? (status as PinnedSkillStatus)
        : null,
    };
  });
}

/** What the assistant's read of a skill's `SKILL.md` did: a plain read, or a new pin. */
type SkillLoadOutcome = "read" | "pinned";

/**
 * The assistant's load of a skill's `SKILL.md` (`text`) in a persisted turn. A skill this turn
 * already injected (system prompt or an earlier load) is a plain read; any other is pinned to
 * the conversation, so later turns inject it from the system prompt. Throws the refusal the
 * model reads, with nothing marked, when the text does not fit the budget the turn has left or
 * the conversation already pins {@link MAX_PINNED_SKILLS} skills.
 */
export type SkillLoad = (packageId: string, text: string) => Promise<SkillLoadOutcome>;

/**
 * The turn's {@link SkillLoad}, from what its system prompt injected. `pin` is the atomic
 * append (`pinAssistantSkill`): false when the conversation is full, a lost race included.
 */
export function turnSkillLoad(opts: {
  injected: Iterable<string>;
  budgetLeft: number;
  pin: (packageId: string) => Promise<boolean>;
}): SkillLoad {
  const injected = new Set(opts.injected);
  let left = opts.budgetLeft;
  return async (packageId, text) => {
    if (injected.has(packageId)) return "read";
    if (text.length > left) {
      throw new Error(
        `The skill \`${packageId}\` was not loaded: its SKILL.md (${text.length} characters) does not fit the ${left} characters left of the ${CHAT_SKILLS_CONTENT_BUDGET_CHARS} the conversation's skills share. Nothing was pinned. Tell the user: they can unpin a skill in the skills panel of the composer to make room.`,
      );
    }
    if (!(await opts.pin(packageId))) {
      throw new Error(
        `The skill \`${packageId}\` was not loaded: this conversation already pins ${MAX_PINNED_SKILLS} skills, the most it holds. Nothing was pinned. Tell the user: they can unpin a skill in the skills panel of the composer, then ask again.`,
      );
    }
    injected.add(packageId);
    left -= text.length;
    return "pinned";
  };
}
