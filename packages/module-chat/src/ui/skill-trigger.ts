// SPDX-License-Identifier: Apache-2.0

// An open `/` trigger swallows Enter even with no rows (`regarde /outputs` would
// not send), so it opens only on queries some skill id contains — never on none.

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

// A label's name part is a substring of its id, so the id alone decides.
function skillMatchesQuery(item: Unstable_Mention, query: string): boolean {
  return item.id.toLowerCase().includes(query.toLowerCase());
}

/** A bare `/` lists everything, so it opens whenever there is something to list. */
export function createSkillTriggerMatcher(items: readonly Unstable_Mention[]) {
  return (
    text: string,
    triggerChar: string,
    cursorPosition: number,
  ): Unstable_TriggerMatch | null => {
    if (items.length === 0) return null;
    const match = detectWordInitialTrigger(text, triggerChar, cursorPosition);
    if (match === null || match.query === "") return match;
    return items.some((item) => skillMatchesQuery(item, match.query)) ? match : null;
  };
}
