// SPDX-License-Identifier: Apache-2.0

/**
 * Pending tool approvals: maps an approval id to the promise a chat turn is
 * awaiting before it lets a writing tool call run. The turn registers the
 * approval and waits; `POST /api/chat/sessions/:id/approvals/:approvalId`
 * resolves it.
 *
 * In-process only, like `stop-registry.ts`: an answer that lands on another
 * node finds nothing and the turn refuses on its own when it ends. Same
 * follow-up as the stop: the platform's cancel Pub/Sub.
 */

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

interface PendingApproval {
  /** Owning chat session: an answer is accepted only through its own session. */
  chatSessionId: string;
  resolve: (decision: ApprovalDecision) => void;
}

const pending = new Map<string, PendingApproval>();

/**
 * Wait for the answer to `approvalId`. The turn's `signal` (stop, deadline)
 * settles it as a refusal: nothing runs without an answer.
 */
export function awaitApproval(
  approvalId: string,
  chatSessionId: string,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const settle = (decision: ApprovalDecision) => {
      pending.delete(approvalId);
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = () => settle({ approved: false });
    if (signal.aborted) return onAbort();
    pending.set(approvalId, { chatSessionId, resolve: settle });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Answer a pending approval. Returns false if none matched this session. */
export function resolveApproval(
  approvalId: string,
  chatSessionId: string,
  decision: ApprovalDecision,
): boolean {
  const entry = pending.get(approvalId);
  if (!entry || entry.chatSessionId !== chatSessionId) return false;
  entry.resolve(decision);
  return true;
}
