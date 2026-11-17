// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's inline-run model switch, client side: a per-user preference,
 * OFF unless that user turned it on — the departure from the default is the
 * one value stored. The server half is `chat-stream-handler.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  bindInlineRunModelUser,
  getInlineRunModelEnabled,
  setInlineRunModelEnabled,
} from "../src/ui/inline-run-model-store.ts";
import { bindChatPreferencesUser } from "../src/ui/preferences.ts";
import {
  getPackageAuthoringEnabled,
  setPackageAuthoringEnabled,
} from "../src/ui/package-authoring-store.ts";

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
  setInlineRunModelEnabled(false);
  setPackageAuthoringEnabled(true);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("the inline-run model preference", () => {
  it("is off by default", () => {
    expect(getInlineRunModelEnabled()).toBe(false);
  });

  it("stores only the departure from the default", () => {
    const data = installStorage();
    bindInlineRunModelUser("usr_a");
    setInlineRunModelEnabled(true);
    expect(data.get("appstrate.chat.inlineRunModel:usr_a")).toBe("on");
    setInlineRunModelEnabled(false);
    expect(data.has("appstrate.chat.inlineRunModel:usr_a")).toBe(false);
  });

  it("is kept per user: one account's choice never carries over to another", () => {
    installStorage();
    bindInlineRunModelUser("usr_a");
    setInlineRunModelEnabled(true);

    bindInlineRunModelUser("usr_b");
    expect(getInlineRunModelEnabled()).toBe(false);

    bindInlineRunModelUser("usr_a");
    expect(getInlineRunModelEnabled()).toBe(true);
  });

  it("is bound with the other composer preferences in one call", () => {
    const data = installStorage();
    data.set("appstrate.chat.inlineRunModel:usr_a", "on");
    data.set("appstrate.chat.packageAuthoring:usr_a", "off");

    bindChatPreferencesUser("usr_a");

    expect(getInlineRunModelEnabled()).toBe(true);
    expect(getPackageAuthoringEnabled()).toBe(false);
  });
});
