// SPDX-License-Identifier: Apache-2.0

/**
 * Bring a tool call's card into view in the thread, from the context panel: its activity group
 * opens (a folded one does not mount its cards) and the card is ringed while it holds the focus.
 */

import * as React from "react";
import { flushSync } from "react-dom";

interface RevealState {
  /** Calls whose group was opened for them, until the reader folds it. */
  readonly opened: ReadonlySet<string>;
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

export function useRevealedToolCalls(): RevealState {
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function forgetRevealedToolCalls(toolCallIds: readonly string[]): void {
  if (!toolCallIds.some((id) => state.opened.has(id))) return;
  const opened = new Set(state.opened);
  for (const id of toolCallIds) opened.delete(id);
  write({ ...state, opened });
}

/** A focus moved by script draws no ring: this one marks the card until the focus leaves it. */
export const REVEAL_RING_CLASS =
  "transition-shadow duration-fast ease-surface data-[revealed]:ring-2 data-[revealed]:ring-ring";

/** A card's anchor: focusable by script only, marked while it is the revealed one. */
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

/** True only when the card took the focus; false when the thread draws none for the call. */
export function revealToolCall(call: { toolCallId: string }): boolean {
  const thread = document.querySelector("[data-chat-thread]");
  if (!thread) return false;
  const { toolCallId } = call;
  // Synchronous, so the opened group's card is on the page below.
  flushSync(() => write({ opened: new Set(state.opened).add(toolCallId), marked: toolCallId }));
  const card = thread.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(toolCallId)}"]`);
  if (!card) {
    write({ ...state, marked: null });
    return false;
  }
  card.scrollIntoView({ block: "center" });
  const control = card.querySelector<HTMLElement>("button, a[href]");
  (control ?? card).focus({ preventScroll: true });
  return card.contains(document.activeElement);
}
