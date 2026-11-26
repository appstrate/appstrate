// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's every-space context switch, client side: a per-user preference, OFF unless that
 * user turned it on, bound with the composer's other preferences. The server half is
 * `chat-stream-handler.test.ts` ("what the spaces hold").
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  getContextAllSpacesEnabled,
  setContextAllSpacesEnabled,
} from "../src/ui/context-all-spaces-store.ts";
import { bindChatPreferencesUser } from "../src/ui/preferences.ts";

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

beforeEach(() => bindChatPreferencesUser(null));
afterEach(() => {
  bindChatPreferencesUser(null);
  setContextAllSpacesEnabled(false);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the every-space context switch", () => {
  it("is off by default, and stores only a user's turning it on", () => {
    const data = installStorage();
    bindChatPreferencesUser("u_1");
    expect(getContextAllSpacesEnabled()).toBe(false);
    setContextAllSpacesEnabled(true);
    expect([...data]).toEqual([["appstrate.chat.contextAllSpaces:u_1", "on"]]);
    // Another account in the same browser starts from the default.
    bindChatPreferencesUser("u_2");
    expect(getContextAllSpacesEnabled()).toBe(false);
    bindChatPreferencesUser("u_1");
    expect(getContextAllSpacesEnabled()).toBe(true);
    setContextAllSpacesEnabled(false);
    expect(data.size).toBe(0);
  });
});
