// SPDX-License-Identifier: Apache-2.0

/**
 * When the `/` popover may open.
 *
 * assistant-ui's default detection opens on ANY word-initial `/`, and while a
 * trigger is open the composer plugin swallows Enter even with zero matching
 * items — so `regarde /outputs` + Enter sends nothing and looks like a broken
 * composer. A `matcher` narrows detection instead of the item list: no match,
 * no open trigger, and Enter is the composer's own send again.
 *
 * The detection itself mirrors the library default (`detectTrigger.js`): scan
 * back from the caret, stop at whitespace, accept a `/` that starts a word.
 * The added rule is the last line — the query must be a prefix of something
 * offerable, where the library's own filter (`matchesTriggerItemQuery`) is a
 * substring match. Prefix, because typing is left to right: `/cop` is on its
 * way to `/copilot`, `/outputs` is on its way to nothing.
 */

import type { Unstable_Mention, Unstable_TriggerMatch } from "@assistant-ui/react";

const WHITESPACE_RE = /\s/u;

/** The default word-initial scan, reimplemented (the library does not export it). */
function detectWordInitialTrigger(
  text: string,
  triggerChar: string,
  cursorPosition: number,
): Unstable_TriggerMatch | null {
  const upToCursor = text.slice(0, cursorPosition);
  for (let i = upToCursor.length - 1; i >= 0; i--) {
    if (WHITESPACE_RE.test(upToCursor[i]!)) return null;
    if (!upToCursor.startsWith(triggerChar, i)) continue;
    if (i > 0 && !WHITESPACE_RE.test(upToCursor[i - 1]!)) continue;
    return {
      query: upToCursor.slice(i + triggerChar.length),
      offset: i,
      endOffset: cursorPosition,
    };
  }
  return null;
}

/** `/copilot (@appstrate)` → `copilot`; the part a user is typing towards. */
function labelNamePart(label: string): string {
  const bare = label.startsWith("/") ? label.slice(1) : label;
  const space = bare.indexOf(" ");
  return space === -1 ? bare : bare.slice(0, space);
}

/** Would this item still be reachable by continuing to type `query`? */
function skillMatchesQuery(item: Unstable_Mention, query: string): boolean {
  const q = query.toLowerCase();
  if (q === "") return true;
  const bare = (item.label.startsWith("/") ? item.label.slice(1) : item.label).toLowerCase();
  return (
    labelNamePart(item.label).toLowerCase().startsWith(q) ||
    bare.startsWith(q) ||
    item.id.toLowerCase().startsWith(q)
  );
}

/**
 * The trigger matcher for a given catalogue. A bare `/` (empty query) always
 * opens — it lists everything, and it is also the only state in which an empty
 * or still-loading catalogue can say so.
 */
export function createSkillTriggerMatcher(items: readonly Unstable_Mention[]) {
  return (
    text: string,
    triggerChar: string,
    cursorPosition: number,
  ): Unstable_TriggerMatch | null => {
    const match = detectWordInitialTrigger(text, triggerChar, cursorPosition);
    if (match === null || match.query === "") return match;
    return items.some((item) => skillMatchesQuery(item, match.query)) ? match : null;
  };
}
