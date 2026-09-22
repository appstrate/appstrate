// SPDX-License-Identifier: Apache-2.0

/**
 * When the `/` popover may open. assistant-ui's default detection opens on ANY
 * word-initial `/`, and an open trigger swallows Enter even with zero matching
 * items — so `regarde /outputs` + Enter sends nothing and looks like a broken
 * composer. A `matcher` narrows DETECTION, not the item list.
 *
 * Detection mirrors the library default (`detectTrigger.js`): scan back from
 * the caret, stop at whitespace, accept a `/` that starts a word. The added
 * rule is the same SUBSTRING test the library's own item filter runs
 * (`matchesTriggerItemQuery`), so an open trigger always has rows behind it.
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

/** Would the popover have this item in it for `query`? */
function skillMatchesQuery(item: Unstable_Mention, query: string): boolean {
  const q = query.toLowerCase();
  if (q === "") return true;
  return labelNamePart(item.label).toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
}

/** A bare `/` always opens — it lists everything, loading catalogue included. */
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
