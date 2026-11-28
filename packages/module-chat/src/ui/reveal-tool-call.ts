// SPDX-License-Identifier: Apache-2.0

/**
 * Bring a tool call's line, or a run's line, into view in the thread, from the context panel: a
 * call's activity group opens (a folded one does not mount its steps; a lone call is the group's
 * line) and the anchored element is ringed while it holds the focus. A run's line is drawn
 * whatever its group's fold, so no group opens for it.
 */

import * as React from "react";
import { flushSync } from "react-dom";
import type { ThreadItem } from "./runtime-context.ts";

interface RevealState {
  /** Calls whose group was opened for them, until the reader folds it. */
  readonly opened: ReadonlySet<string>;
  /** The id (a call's, or a run's) the revealed line is anchored by. */
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

/** A focus moved by script draws no ring: this one marks the line until the focus leaves it. */
export const REVEAL_RING_CLASS =
  "transition-shadow duration-fast ease-surface data-[revealed]:ring-2 data-[revealed]:ring-ring";

/**
 * A line's anchor: focusable by script only, marked while it is the revealed one. A run's line is
 * anchored by its run as well (`runId`), so the panel's Runs tab finds it without its call.
 */
export function useRevealAnchor(toolCallId: string | undefined, runId?: string) {
  const { marked } = useRevealedToolCalls();
  const anchors = (id: string | null) => id !== null && (id === toolCallId || id === runId);
  return {
    "data-tool-call-id": toolCallId,
    "data-run-id": runId,
    "data-revealed": anchors(marked) ? "" : undefined,
    tabIndex: -1,
    onBlur: (event: React.FocusEvent<HTMLElement>) => {
      if (!anchors(state.marked)) return;
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      write({ ...state, marked: null });
    },
  };
}

/**
 * True when the thread draws the item's line, which is then scrolled to and focused; false when it
 * draws none. Call it outside React's render and commit (`flushSync`), with the thread interactive.
 */
export function revealThreadItem({ kind, id }: ThreadItem): boolean {
  const thread = document.querySelector("[data-chat-thread]");
  if (!thread) return false;
  // A call's group opens for it. Synchronous, so the opened group's line is on the page below.
  const opened = kind === "call" ? new Set(state.opened).add(id) : state.opened;
  flushSync(() => write({ opened, marked: id }));
  const attribute = kind === "call" ? "data-tool-call-id" : "data-run-id";
  const line = thread.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`);
  if (!line) {
    write({ ...state, marked: null });
    return false;
  }
  line.scrollIntoView({ block: "center" });
  const control = line.querySelector<HTMLElement>("button, a[href]");
  (control ?? line).focus({ preventScroll: true });
  return true;
}
