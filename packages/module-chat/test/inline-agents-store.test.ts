// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's inline-agents switch, client side.
 *
 * A PREFERENCE, never a gate — the gate is `agents:run-inline`, checked
 * server-side, and the turn narrows its own bearer when this is off
 * (`chat-stream-handler.test.ts`). What matters here is that the default is
 * ON: the switch ships to users who already had inline agents, and a store
 * that read "absent" as "off" would take the capability away on upgrade
 * without anyone deciding to.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
  getInlineAgentsEnabled,
  setInlineAgentsEnabled,
  subscribeInlineAgents,
} from "../src/ui/model-store.ts";

afterEach(() => {
  setInlineAgentsEnabled(true);
});

describe("the inline-agents preference", () => {
  it("is on by default", () => {
    expect(getInlineAgentsEnabled()).toBe(true);
  });

  it("round-trips off and back on", () => {
    // ON is the ABSENCE of a stored value, never a stored `"on"`: a user who
    // never touched the switch and one who turned it back on are the same
    // state, so there is one way to read either. The storage shape is asserted
    // through behaviour rather than through `localStorage` directly — this
    // runner has none, which is also what the store's own guards are for.
    setInlineAgentsEnabled(false);
    expect(getInlineAgentsEnabled()).toBe(false);

    setInlineAgentsEnabled(true);
    expect(getInlineAgentsEnabled()).toBe(true);
  });

  it("survives a runner with no storage at all", () => {
    // Private windows, blocked site data, and this test process. Every read and
    // write is guarded, so an unavailable store costs persistence and nothing
    // else — the switch still works for the session.
    expect(typeof localStorage).toBe("undefined");
    setInlineAgentsEnabled(false);
    expect(getInlineAgentsEnabled()).toBe(false);
  });

  it("notifies subscribers on a real change, and not on a no-op", () => {
    // The composer reads this through `useSyncExternalStore`; a notification
    // for an unchanged value is a re-render of the whole popover for nothing.
    let notifications = 0;
    const unsubscribe = subscribeInlineAgents(() => {
      notifications += 1;
    });
    try {
      setInlineAgentsEnabled(true);
      expect(notifications).toBe(0);

      setInlineAgentsEnabled(false);
      expect(notifications).toBe(1);

      setInlineAgentsEnabled(false);
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
    }
  });
});
