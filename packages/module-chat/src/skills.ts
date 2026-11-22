// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects (the result sits in the system prompt's single
// `cache_control` block), and what the assistant's reads of them pin.

import type { InjectedSkill, InjectedSkills } from "@appstrate/core/chat-contract";
import type { ChatSkillStatus } from "@appstrate/db/schema";
import { logger } from "./logger.ts";

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
  /** Injected in full on every turn, whatever `skillDiscovery`. */
  pinnedSkills: string[];
}

/** Why a turn left a pinned skill out of its context; `injected` when it did not. */
export type PinnedSkillStatus = ChatSkillStatus;

/** Who pinned a skill: the user (panel, `/` citation) or the assistant (loading its `SKILL.md`). */
export const PINNED_SKILL_SOURCES = ["user", "assistant"] as const;
export type PinnedSkillSource = (typeof PINNED_SKILL_SOURCES)[number];

/** A pin as the session DTOs carry it (`skills`); `status` is `null` until a claiming turn evaluates it. */
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

/** `pinned` after `changes`: unpins out, pins in, sorted and deduped. The claim applies the same rule in SQL. */
export function applySkillChanges(
  pinned: readonly string[],
  changes: Pick<ChatSkillChanges, "pin" | "unpin">,
): string[] {
  const unpin = new Set(changes.unpin);
  return [...new Set([...pinned.filter((id) => !unpin.has(id)), ...changes.pin])].sort();
}

/** The selection a turn carrying `changes` works with, before its claim writes it. */
export function selectionAfter(
  stored: ChatSkillSelection,
  changes: ChatSkillChanges,
): ChatSkillSelection {
  return {
    skillDiscovery: changes.skillDiscovery ?? stored.skillDiscovery,
    pinnedSkills: applySkillChanges(stored.pinnedSkills, changes),
  };
}

export const DEFAULT_SKILL_SELECTION: ChatSkillSelection = {
  skillDiscovery: true,
  pinnedSkills: [],
};

interface ResolvedChatSkills {
  injected: SkillContent[];
  notices: string[];
  /** Each pin's verdict: what the turn's claim writes to `skill_status`. */
  statuses: Record<string, PinnedSkillStatus>;
  /** The characters of the shared budget the injected skills leave: what an assistant load may take. */
  left: number;
}

/**
 * The skills to inject: the pinned ones in stored order, out of one budget. `contents` holds the
 * pins found here: read, or `null` when their read failed or answered malformed; a skill absent
 * from it is in no listing.
 */
export function resolveChatSkills(
  selection: ChatSkillSelection,
  contents: ReadonlyMap<string, SkillContent | null>,
): ResolvedChatSkills {
  const resolved: ResolvedChatSkills = {
    injected: [],
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

/** The pins of a session row as its DTOs carry them (`skills`); every write stores them sorted. */
export function pinnedSkillsOf(row: {
  pinnedSkills: readonly string[];
  assistantSkills: readonly string[];
  skillStatus: Readonly<Partial<Record<string, ChatSkillStatus>>>;
}): PinnedSkill[] {
  const assistant = new Set(row.assistantSkills);
  return row.pinnedSkills.map((id) => ({
    id,
    source: assistant.has(id) ? "assistant" : "user",
    status: row.skillStatus[id] ?? null,
  }));
}

/**
 * What `pinAssistantSkill` answered for a skill: `pinned` by this call, `already_pinned`, or
 * left unpinned because the conversation is `full` or the turn `released` it.
 */
export type SkillPinOutcome = "pinned" | "already_pinned" | "full" | "released";

/**
 * What a read of a skill's `SKILL.md` did to the conversation's pins: `pinned` when the database
 * confirms the skill pinned now (its replay is a receipt), else a plain read, with the `note`
 * the model is told when a pin it attempted was refused.
 */
export interface SkillLoadResult {
  pinned: boolean;
  note?: string;
}

/**
 * The assistant's read of a skill file `uri` that answered `text`, in a persisted turn: undefined
 * unless it is the `SKILL.md` this conversation injects for its skill. Never throws: a refused pin
 * leaves the read a plain one.
 */
export type SkillLoad = (uri: string, text: string) => Promise<SkillLoadResult | undefined>;

const UNPIN_HINT =
  "Tell the user: they can unpin a skill in the skills panel of the composer to make room.";
const notPinned = (packageId: string, why: string): SkillLoadResult => ({
  pinned: false,
  note: `The skill \`${packageId}\` was read for this turn but not pinned to the conversation: ${why} Later turns will not have it unless it is read again.`,
});
const PIN_REFUSALS: Record<"full" | "released" | "failed", string> = {
  full: `this conversation already pins ${MAX_PINNED_SKILLS} skills, the most it holds. ${UNPIN_HINT}`,
  released: "this turn no longer holds the conversation (it was stopped or another turn started).",
  failed: "the pin could not be recorded.",
};
const PLAIN_READ: SkillLoadResult = { pinned: false };

/**
 * The turn's {@link SkillLoad}. `uris` maps each skill the turn can see to the `SKILL.md` URI its
 * injection would use; `pinned` and `injected` are the turn's pins and those its system prompt
 * injected, `budgetLeft` what it left. A pin of the turn (injected or not) is never pinned again
 * and spends no budget: an injected one, or one this turn pinned, gets a receipt only while
 * `isPinned(id)` still finds it pinned. A new load reserves its share of the budget before its
 * pin is awaited, and a parallel read of the same skill waits for it, so concurrent tool calls
 * never spend the budget twice; a refused pin gives the reservation back.
 */
export function turnSkillLoad(opts: {
  uris: ReadonlyMap<string, string>;
  pinned: Iterable<string>;
  injected: Iterable<string>;
  budgetLeft: number;
  pin: (packageId: string) => Promise<SkillPinOutcome>;
  isPinned: (packageId: string) => Promise<boolean>;
}): SkillLoad {
  const pinnedAtStart = new Set(opts.pinned);
  // The skills whose text this turn's context holds: what a re-read gets a receipt for.
  const held = new Set(opts.injected);
  const inFlight = new Map<string, Promise<SkillLoadResult>>();
  let left = opts.budgetLeft;
  const load: SkillLoad = async (uri, text) => {
    const packageId = [...opts.uris].find(([, injectedAt]) => injectedAt === uri)?.[0];
    if (packageId === undefined) return undefined;
    const pending = inFlight.get(packageId);
    if (pending) {
      await pending;
      return load(uri, text);
    }
    if (held.has(packageId)) {
      const pinned = await opts.isPinned(packageId).catch((error: unknown) => {
        logger.warn("chat skill pin check failed", { packageId, error: String(error) });
        return false;
      });
      return { pinned };
    }
    if (pinnedAtStart.has(packageId)) return PLAIN_READ;
    if (text.length > left) {
      return notPinned(
        packageId,
        `its SKILL.md (${text.length} characters) does not fit the ${left} characters left of the ${CHAT_SKILLS_CONTENT_BUDGET_CHARS} the conversation's skills share. ${UNPIN_HINT}`,
      );
    }
    left -= text.length;
    const attempt = opts
      .pin(packageId)
      .catch((error: unknown) => {
        logger.warn("chat assistant skill pin failed", { packageId, error: String(error) });
        return "failed" as const;
      })
      .then((outcome): SkillLoadResult => {
        inFlight.delete(packageId);
        if (outcome === "pinned" || outcome === "already_pinned") {
          held.add(packageId);
          return { pinned: true };
        }
        left += text.length;
        return notPinned(packageId, PIN_REFUSALS[outcome]);
      });
    inFlight.set(packageId, attempt);
    return attempt;
  };
  return load;
}
