// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side queue of messages typed while the agent is still answering. The
 * server only ever sees ONE user message: when the turn ends, everything queued
 * is joined and sent together. Pure logic + a tiny external store, so React reads
 * it with `useSyncExternalStore` (no setState in effects) and tests need no DOM.
 */

import { namesAgent, type DraftIssue } from "./directive-send.ts";

export interface QueueSnapshot {
  readonly items: readonly string[];
  /** The user pressed Stop during the current turn: its queue is held, not auto-sent. */
  readonly stopped: boolean;
}

/** Queued texts become one message, one paragraph each. */
export function joinQueued(items: readonly string[]): string {
  return items.join("\n\n");
}

/**
 * Whether the draft can join the queue: a turn runs, it is text alone, and it names no agent
 * (a queued message is sent after the turn, as one message with the others: no agent launch
 * waits in a queue, and none is started by surprise). Skills it names are pinned when it is sent.
 */
export function canQueueDraft(input: {
  running: boolean;
  text: string;
  hasAttachments: boolean;
  /** `draftIssue` of the queue with the draft joined: they are sent as one message. */
  issue: DraftIssue | null;
}): boolean {
  return (
    input.running &&
    !input.hasAttachments &&
    input.text.trim() !== "" &&
    !namesAgent(input.text) &&
    input.issue !== "pins"
  );
}

export type FlushDecision = "send" | "hold" | "none";

/**
 * What to do when a render observes the running flag. Only the running → idle
 * edge matters; an error ending the turn still flushes (the user asked for the
 * messages), a Stop does not (they stopped for a reason).
 */
export function flushDecision(input: {
  wasRunning: boolean;
  running: boolean;
  snapshot: QueueSnapshot;
}): FlushDecision {
  if (!input.wasRunning || input.running || input.snapshot.items.length === 0) return "none";
  return input.snapshot.stopped ? "hold" : "send";
}

export interface MessageQueue {
  getSnapshot: () => QueueSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Appends a text; blank text is ignored. Returns whether it was queued. */
  add: (text: string) => boolean;
  remove: (index: number) => void;
  /** Empties the queue and clears the stopped mark. */
  clear: () => void;
  markStopped: () => void;
  /** The turn ended without the queue being sent: forget the Stop, keep the items. */
  releaseStop: () => void;
}

export function createMessageQueue(): MessageQueue {
  let snapshot: QueueSnapshot = { items: [], stopped: false };
  const listeners = new Set<() => void>();
  const set = (next: QueueSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    add: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      set({ ...snapshot, items: [...snapshot.items, trimmed] });
      return true;
    },
    remove: (index) => {
      if (index < 0 || index >= snapshot.items.length) return;
      set({ ...snapshot, items: snapshot.items.filter((_, i) => i !== index) });
    },
    clear: () => {
      if (snapshot.items.length === 0 && !snapshot.stopped) return;
      set({ items: [], stopped: false });
    },
    markStopped: () => {
      if (!snapshot.stopped) set({ ...snapshot, stopped: true });
    },
    releaseStop: () => {
      if (snapshot.stopped) set({ ...snapshot, stopped: false });
    },
  };
}
