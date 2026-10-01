// SPDX-License-Identifier: Apache-2.0

/**
 * Pending human replies: maps an id to the promise a chat turn is awaiting
 * before it goes on — an approval of a writing tool call (`tool-approval.ts`),
 * or the answers to an `ask_user` questionnaire (`ask-user.ts`). The turn
 * registers and waits; the matching route resolves it. Each entry carries its
 * kind, and only a reply of that kind resolves it, so an approval id sent to
 * the questions route (or the reverse) answers nothing.
 *
 * In-process only, like `stop-registry.ts`: a reply that lands on another node
 * finds nothing and the turn settles on its own when it ends. Same follow-up
 * as the stop: the platform's cancel Pub/Sub.
 */

export type ReplyKind = "approval" | "question";

interface PendingReply {
  kind: ReplyKind;
  /** Owning chat session: a reply is accepted only through its own session. */
  chatSessionId: string;
  resolve: (reply: unknown) => void;
}

const pending = new Map<string, PendingReply>();

/**
 * Wait for the reply to `id`. The turn's `signal` (stop, deadline) settles it
 * with `onAbort`: nothing waits past the turn. `onChange` runs when the wait
 * starts and when it ends, so the session list can say a conversation needs
 * the person (`hasPendingReply`).
 */
export function awaitReply<T>(
  kind: ReplyKind,
  id: string,
  chatSessionId: string,
  signal: AbortSignal,
  onAbort: T,
  onChange?: () => void,
): Promise<T> {
  return new Promise((resolve) => {
    const settle = (reply: unknown) => {
      pending.delete(id);
      signal.removeEventListener("abort", onSignal);
      resolve(reply as T);
      onChange?.();
    };
    const onSignal = () => settle(onAbort);
    if (signal.aborted) return onSignal();
    pending.set(id, { kind, chatSessionId, resolve: settle });
    signal.addEventListener("abort", onSignal, { once: true });
    onChange?.();
  });
}

/** Whether a turn of this session waits on the person (an approval or questions). */
export function hasPendingReply(chatSessionId: string): boolean {
  for (const entry of pending.values()) if (entry.chatSessionId === chatSessionId) return true;
  return false;
}

/** Hand `reply` to the turn waiting on `id`. False when none of this kind waits in this session. */
export function resolveReply(
  kind: ReplyKind,
  id: string,
  chatSessionId: string,
  reply: unknown,
): boolean {
  const entry = pending.get(id);
  if (!entry || entry.kind !== kind || entry.chatSessionId !== chatSessionId) return false;
  entry.resolve(reply);
  return true;
}
