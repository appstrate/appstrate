// SPDX-License-Identifier: Apache-2.0

/**
 * The open conversation's messages as its runtime holds them, the turn in flight included: the
 * host's context panel is drawn outside the runtime, and the stored ones miss that turn.
 */

import * as React from "react";
import type { UIMessage } from "ai";

export interface LiveConversation {
  readonly messages: readonly UIMessage[];
  /** Its last message is in flight. */
  readonly running: boolean;
}

const conversations = new Map<string, LiveConversation>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publishLiveConversation(id: string, conversation: LiveConversation): void {
  conversations.set(id, conversation);
  notify();
}

export function withdrawLiveConversation(id: string): void {
  if (conversations.delete(id)) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `undefined` while no runtime holds conversation `id`, or `enabled` is false. */
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
