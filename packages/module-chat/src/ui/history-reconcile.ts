// SPDX-License-Identifier: Apache-2.0

/**
 * History ↔ resume self-heal decision (pure, no React).
 *
 * `Conversation` loads history ONCE (mount-only) and `useChat({ resume })`
 * fires ONCE. If the turn finalizes between those two GETs — history returned
 * the user message while the reply was still streaming, then the resume GET
 * answered 204 because nothing was generating any more — the client shows a
 * user message with no reply until a manual reload. Nothing re-invalidates the
 * module's history key on its own.
 *
 * The signal that the gap happened is already in the shared session list: the
 * server row reports `generating: false` with a fresh `updatedAt`, while the
 * local thread ends on a `user` message and the local runtime is idle. This
 * function decides, from those facts alone, whether the history should be
 * refetched and swapped into the runtime (`chat.setMessages`, no remount).
 *
 * The `lastReconciledUpdatedAt` guard is what stops the loop: a reconcile is
 * attempted at most once per server `updatedAt`, so a turn that genuinely
 * ended without an assistant message (server-side failure) costs one GET,
 * not one per list refetch.
 *
 * Stored messages carry no timestamp metadata (the module never stamps any),
 * so "server newer than the last local assistant message" cannot be evaluated
 * — the last-message-role test is the whole rule.
 */

export type ReconcileChatStatus = "submitted" | "streaming" | "ready" | "error";

export interface ReconcileInput {
  /** `useChat().status` — anything in flight locally vetoes the reconcile. */
  status: ReconcileChatStatus;
  /** `generating` from the server's session row; `undefined` = no row yet. */
  serverGenerating: boolean | undefined;
  /** `updatedAt` from the server's session row; `undefined` = no row yet. */
  serverUpdatedAt: string | undefined;
  /** The runtime's current messages (only the last role is consulted). */
  localMessages: ReadonlyArray<{ role: string }>;
  /** The `serverUpdatedAt` the last reconcile ran at, or `null` for none. */
  lastReconciledUpdatedAt: string | null;
}

export function shouldReconcileHistory(input: ReconcileInput): boolean {
  const { status, serverGenerating, serverUpdatedAt, localMessages, lastReconciledUpdatedAt } =
    input;
  // A local turn in flight will deliver its own reply; never race it.
  if (status === "submitted" || status === "streaming") return false;
  // The server is still (or again) producing — the row will change once more.
  if (serverGenerating !== false) return false;
  // No row means nothing to compare against (unpersisted conversation).
  if (!serverUpdatedAt) return false;
  // Already reconciled at this server state: nothing new can have landed.
  if (serverUpdatedAt === lastReconciledUpdatedAt) return false;
  const last = localMessages[localMessages.length - 1];
  // A thread ending on the assistant is complete as far as we can tell.
  return last?.role === "user";
}
