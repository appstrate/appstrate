// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's agent-authoring switch, client side: a per-user preference,
 * on unless that user opted out. The gate itself is `agents:write`, dropped
 * from the turn's token server-side (`chat-stream-handler.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  bindAgentAuthoringUser,
  getAgentAuthoringEnabled,
  setAgentAuthoringEnabled,
  subscribeAgentAuthoring,
} from "../src/ui/agent-authoring-store.ts";

/** This runner has no `localStorage`; a Map-backed one stands in. */
function installStorage(): Map<string, string> {
  const data = new Map<string, string>();
  (
    globalThis as { localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> }
  ).localStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return data;
}

beforeEach(() => bindAgentAuthoringUser(null));
afterEach(() => {
  bindAgentAuthoringUser(null);
  setAgentAuthoringEnabled(true);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the agent-authoring preference", () => {
  it("is on by default", () => {
    expect(getAgentAuthoringEnabled()).toBe(true);
  });

  it("is kept per user: one account's choice never carries over to another", () => {
    installStorage();
    bindAgentAuthoringUser("usr_a");
    setAgentAuthoringEnabled(false);

    bindAgentAuthoringUser("usr_b");
    expect(getAgentAuthoringEnabled()).toBe(true);

    bindAgentAuthoringUser("usr_a");
    expect(getAgentAuthoringEnabled()).toBe(false);
  });

  it("persists nothing while no user is bound", () => {
    const data = installStorage();
    setAgentAuthoringEnabled(false);
    expect(data.size).toBe(0);
  });

  it("round-trips without storage at all", () => {
    expect(typeof localStorage).toBe("undefined");
    bindAgentAuthoringUser("usr_a");
    setAgentAuthoringEnabled(false);
    expect(getAgentAuthoringEnabled()).toBe(false);
  });

  it("notifies subscribers on a real change only", () => {
    let notifications = 0;
    const unsubscribe = subscribeAgentAuthoring(() => {
      notifications += 1;
    });
    try {
      setAgentAuthoringEnabled(true);
      expect(notifications).toBe(0);
      setAgentAuthoringEnabled(false);
      expect(notifications).toBe(1);
      setAgentAuthoringEnabled(false);
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});
