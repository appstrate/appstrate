// SPDX-License-Identifier: Apache-2.0

// Which skills a chat turn injects, and what the assistant's reads of them pin.

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
  pinnedSkills: string[];
}

export type { ChatSkillStatus };

/** Who pinned a skill: the user (panel, `/` citation) or the assistant (loading its `SKILL.md`). */
export const PINNED_SKILL_SOURCES = ["user", "assistant"] as const;
type PinnedSkillSource = (typeof PINNED_SKILL_SOURCES)[number];

/** A pin as the session DTOs carry it (`skills`); `status` is `null` until a claiming turn evaluates it. */
export interface PinnedSkill {
  id: string;
  source: PinnedSkillSource;
  status: ChatSkillStatus | null;
}

/** A turn's change to the stored selection: deltas, never a full set, so a stale client drops no pin. */
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
  statuses: Record<string, ChatSkillStatus>;
  /** The characters of the shared budget the injected skills leave: what an assistant load may take. */
  left: number;
}

/** The pins to inject, in stored order, out of one budget; `contents` maps each listed pin to its read (`null`: unreadable). */
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

/** `pinned` (now or already), else refused: the conversation is `full`, or the turn `released` it. */
export type SkillPinOutcome = "pinned" | "full" | "released";

/** What a read of a skill's `SKILL.md` did to its pin (see {@link turnSkillLoad}); `note` tells the model a pin was refused. */
interface SkillLoadResult {
  pinned: boolean;
  note?: string;
}

/** A read of `uri` answering `text`: undefined unless it is a skill's injected `SKILL.md`; never throws. */
export type SkillLoad = (uri: string, text: string) => Promise<SkillLoadResult | undefined>;

export const UNPIN_HINT =
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
 * The turn's {@link SkillLoad}; `uris` maps each visible skill to its injected `SKILL.md` URI. A
 * re-read pin is never pinned again nor spends budget: an injected one (or one this turn pinned)
 * replays as a receipt while `isPinned` holds; one left out is a plain read. A new load reserves
 * its budget before its pin is awaited (a parallel read of it waits), so the budget is never
 * spent twice; a refused pin gives it back.
 */
export function turnSkillLoad(opts: {
  uris: ReadonlyMap<string, string>;
  pinned: Iterable<string>;
  injected: Iterable<string>;
  budgetLeft: number;
  pin: (packageId: string) => Promise<SkillPinOutcome>;
  isPinned: (packageId: string) => Promise<boolean>;
}): SkillLoad {
  const packageByUri = new Map([...opts.uris].map(([packageId, uri]) => [uri, packageId]));
  const pinnedAtStart = new Set(opts.pinned);
  // The skills whose text this turn's context holds: what a re-read gets a receipt for.
  const held = new Set(opts.injected);
  const inFlight = new Map<string, Promise<SkillLoadResult>>();
  let left = opts.budgetLeft;
  const load: SkillLoad = async (uri, text) => {
    const packageId = packageByUri.get(uri);
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
        if (outcome === "pinned") {
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
