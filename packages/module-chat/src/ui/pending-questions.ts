// SPDX-License-Identifier: Apache-2.0

/**
 * The `ask_user` calls the live turn is waiting on, in the order they arrived.
 * The tool row in the transcript holds its call here while it waits; the
 * composer reads the first one and gives its place to the question panel, the
 * way a coding agent's question replaces its input. Module state, like the
 * composer switches: one conversation is mounted at a time, and every hold is
 * released when its row unmounts.
 */

import { useSyncExternalStore } from "react";

export interface PendingQuestion {
  toolCallId: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>;
}

let pending: PendingQuestion[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Hold `question` until the returned release is called. */
export function holdPendingQuestion(question: PendingQuestion): () => void {
  pending = [...pending.filter((q) => q.toolCallId !== question.toolCallId), question];
  notify();
  return () => {
    pending = pending.filter((q) => q.toolCallId !== question.toolCallId);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The question the composer should give its place to, if any. */
export function usePendingQuestion(): PendingQuestion | undefined {
  return useSyncExternalStore(
    subscribe,
    () => pending[0],
    () => undefined,
  );
}
