// SPDX-License-Identifier: Apache-2.0

// Server-only: what the assistant's reads of a skill's `SKILL.md` pin during a turn.
// Kept out of `skills.ts`, which the browser UI imports and must stay free of the logger.

import { logger } from "./logger.ts";
import { CHAT_SKILLS_CONTENT_BUDGET_CHARS, MAX_PINNED_SKILLS } from "./skills.ts";

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
  note: `The skill \`${packageId}\` was read for this turn but not pinned to the conversation: ${why} Its text stays in this conversation's history, which summarization may drop, but the system prompt will not inject it on later turns.`,
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
