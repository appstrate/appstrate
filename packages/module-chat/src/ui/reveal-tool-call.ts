// SPDX-License-Identifier: Apache-2.0

/**
 * Bring a tool call's card into view in the thread, from the context panel.
 *
 * The thread draws what this store says ({@link useRevealedToolCalls}): the activity group holding
 * a revealed call opens (`activity-group-view.tsx`), since a folded group does not mount its cards
 * (Radix `CollapsibleContent`), and the revealed card carries `data-revealed`, which its own class
 * rings ({@link REVEAL_RING_CLASS}). The store is written in `flushSync`, so the card is on the
 * page when {@link revealToolCall} looks for it.
 *
 * Motion is the design system's (`apps/web/DESIGN_SYSTEM.md`, Motion): the scroll takes the
 * thread's own `scroll-behavior`, and the ring fades on `duration-fast` with `ease-surface`;
 * reduced motion is handled once by the stylesheet, never here.
 */

import * as React from "react";
import { flushSync } from "react-dom";

interface RevealState {
  /** The calls whose group was opened to show them, until the reader folds it again. */
  readonly opened: ReadonlySet<string>;
  /** The call whose card is marked, until the focus leaves it. */
  readonly marked: string | null;
}

let state: RevealState = { opened: new Set(), marked: null };
const listeners = new Set<() => void>();

function write(next: RevealState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => state;

/** What the thread shows of the revealed calls. */
export function useRevealedToolCalls(): RevealState {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The reader folded a group again: its calls no longer hold it open. */
export function forgetRevealedToolCalls(toolCallIds: readonly string[]): void {
  if (!toolCallIds.some((id) => state.opened.has(id))) return;
  const opened = new Set(state.opened);
  for (const id of toolCallIds) opened.delete(id);
  write({ ...state, opened });
}

/** A focus moved by script draws no ring: this one marks the card until the focus leaves it. */
export const REVEAL_RING_CLASS =
  "transition-shadow duration-fast ease-surface data-[revealed]:ring-2 data-[revealed]:ring-ring";

/**
 * What a call's card carries: its anchor, focusable by script (out of the tab order) for a card
 * without a control of its own, and the mark while it is the revealed one, dropped when the focus
 * leaves the card.
 */
export function useRevealAnchor(toolCallId: string | undefined) {
  const { marked } = useRevealedToolCalls();
  return {
    "data-tool-call-id": toolCallId,
    "data-revealed": toolCallId !== undefined && marked === toolCallId ? "" : undefined,
    tabIndex: -1,
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (toolCallId === undefined || state.marked !== toolCallId) return;
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      write({ ...state, marked: null });
    },
  };
}

/**
 * Bring the card of the call `toolCallId` into view and give it the focus, opening the group
 * that folds it. True only when the card itself took the focus; false when the thread draws no
 * card for the call.
 */
export function revealToolCall(call: { toolCallId: string }): boolean {
  const thread = document.querySelector("[data-chat-thread]");
  if (!thread) return false;
  const { toolCallId } = call;
  flushSync(() => write({ opened: new Set(state.opened).add(toolCallId), marked: toolCallId }));
  const card = thread.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
  if (!card) {
    write({ ...state, marked: null });
    return false;
  }
  card.scrollIntoView({ block: "center" });
  // The card's own control takes the focus: a keyboard reader lands where the eye does.
  const control = card.querySelector<HTMLElement>("button, a[href]");
  (control ?? card).focus({ preventScroll: true });
  return card.contains(document.activeElement);
}
