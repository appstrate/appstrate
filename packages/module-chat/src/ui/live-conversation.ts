// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's messages as its runtime holds them (`useChat` in `index.tsx`): the
 * history it was seeded with and the turn in flight, frame by frame. The host's context panel is
 * drawn beside the chat, outside its runtime, and reads them here ({@link useLiveConversation}),
 * where the stored messages would miss the turn until it is persisted at its end.
 */

import * as React from "react";
import type { UIMessage } from "ai";

export interface LiveConversation {
  /** Every message the runtime holds, history included. */
  readonly messages: readonly UIMessage[];
  /** A turn is being sent or streamed: its last message is in flight. */
  readonly running: boolean;
}

const conversations = new Map<string, LiveConversation>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The runtime of conversation `id` holds `conversation`. */
export function publishLiveConversation(id: string, conversation: LiveConversation): void {
  conversations.set(id, conversation);
  notify();
}

/** The runtime of conversation `id` is gone. */
export function withdrawLiveConversation(id: string): void {
  if (conversations.delete(id)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The conversation `id` as its open runtime holds it; `undefined` while no runtime holds it
 * (its history still loading, no such conversation, or `enabled` false).
 */
export function useLiveConversation(
  id: string | null,
  enabled = true,
): LiveConversation | undefined {
  const read = React.useCallback(
    () => (enabled && id !== null ? conversations.get(id) : undefined),
    [enabled, id],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}
