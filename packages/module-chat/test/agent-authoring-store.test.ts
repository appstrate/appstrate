// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's agent-authoring switch, client side.
 *
 * A PREFERENCE, never a gate — the gate is `agents:write`, checked
 * server-side, and the turn narrows its own token when this is off
 * (`chat-stream-handler.test.ts`). What matters here is that the default is
 * ON: only an explicit opt-out turns it off.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  getAgentAuthoringEnabled,
  setAgentAuthoringEnabled,
  subscribeAgentAuthoring,
} from "../src/ui/agent-authoring-store.ts";

afterEach(() => {
  setAgentAuthoringEnabled(true);
});

describe("the agent-authoring preference", () => {
  it("is on by default", () => {
    expect(getAgentAuthoringEnabled()).toBe(true);
  });

  it("round-trips off and back on without storage", () => {
    // This runner has no `localStorage`, like a private window with blocked
    // site data: every access is guarded, so only persistence is lost.
    expect(typeof localStorage).toBe("undefined");
    setAgentAuthoringEnabled(false);
    expect(getAgentAuthoringEnabled()).toBe(false);

    setAgentAuthoringEnabled(true);
    expect(getAgentAuthoringEnabled()).toBe(true);
  });

  it("notifies subscribers on a real change, and not on a no-op", () => {
    // The composer reads this through `useSyncExternalStore`; a notification
    // for an unchanged value is a re-render for nothing.
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
