// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { shouldReconcileHistory, type ReconcileInput } from "../src/ui/history-reconcile.ts";

const USER = { role: "user" };
const ASSISTANT = { role: "assistant" };

/** The gap case: idle runtime, server idle, thread ends on the user message. */
const GAP: ReconcileInput = {
  status: "ready",
  serverGenerating: false,
  serverUpdatedAt: "2026-09-02T10:00:05.000Z",
  localMessages: [USER],
  lastReconciledUpdatedAt: null,
};

describe("shouldReconcileHistory", () => {
  it("reconciles when the server is idle and the local thread ends on a user message", () => {
    expect(shouldReconcileHistory(GAP)).toBe(true);
    // Same rule after a local error (network drop mid-turn, server finished).
    expect(shouldReconcileHistory({ ...GAP, status: "error" })).toBe(true);
    // A longer thread that still ends on the user is the same gap.
    expect(shouldReconcileHistory({ ...GAP, localMessages: [USER, ASSISTANT, USER] })).toBe(true);
  });

  it("never reconciles while a local turn is in flight (negative control)", () => {
    expect(shouldReconcileHistory({ ...GAP, status: "streaming" })).toBe(false);
    expect(shouldReconcileHistory({ ...GAP, status: "submitted" })).toBe(false);
  });

  it("does not reconcile a thread that already ends on an assistant reply", () => {
    expect(shouldReconcileHistory({ ...GAP, localMessages: [USER, ASSISTANT] })).toBe(false);
    // …and an empty thread has nothing to heal.
    expect(shouldReconcileHistory({ ...GAP, localMessages: [] })).toBe(false);
  });

  it("does not reconcile twice at the same server updatedAt (loop guard)", () => {
    expect(shouldReconcileHistory({ ...GAP, lastReconciledUpdatedAt: GAP.serverUpdatedAt! })).toBe(
      false,
    );
    // A newer server state re-arms it.
    expect(
      shouldReconcileHistory({
        ...GAP,
        lastReconciledUpdatedAt: GAP.serverUpdatedAt!,
        serverUpdatedAt: "2026-09-02T10:00:09.000Z",
      }),
    ).toBe(true);
  });

  it("waits while the server still reports the row generating, and needs a row at all", () => {
    expect(shouldReconcileHistory({ ...GAP, serverGenerating: true })).toBe(false);
    expect(
      shouldReconcileHistory({ ...GAP, serverGenerating: undefined, serverUpdatedAt: undefined }),
    ).toBe(false);
    expect(shouldReconcileHistory({ ...GAP, serverUpdatedAt: undefined })).toBe(false);
  });
});
