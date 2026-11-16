// SPDX-License-Identifier: Apache-2.0

/** The trail's conversation name survives a list filter that does not hold the open conversation. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { chatTrailEntries, resolveCrumbTitle } = await import("./chat-crumb-title.ts");

describe("resolveCrumbTitle", () => {
  it("names a conversation the list does not hold from the conversation itself", () => {
    expect(resolveCrumbTitle(undefined, { title: "Budget" }, "Nouvelle")).toBe("Budget");
  });

  it("prefers the list's row, which a rename updates live", () => {
    expect(resolveCrumbTitle({ title: "Renamed" }, { title: "Old" }, "Nouvelle")).toBe("Renamed");
  });

  it("falls back to the untitled label, and to null for an unknown conversation", () => {
    expect(resolveCrumbTitle({ title: null }, undefined, "Nouvelle")).toBe("Nouvelle");
    expect(resolveCrumbTitle(undefined, undefined, "Nouvelle")).toBeNull();
  });
});

describe("chatTrailEntries", () => {
  it("adds the spaces slot after the name when the conversation touched some", () => {
    expect(chatTrailEntries("Chat", "Budget", false, 2)).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "Budget" },
      { label: "", slot: true },
    ]);
  });

  it("draws nothing for a conversation that touched none", () => {
    expect(chatTrailEntries("Chat", "Budget", false, 0)).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "Budget" },
    ]);
  });

  it("holds the name's slot while loading and falls back to the chat alone", () => {
    expect(chatTrailEntries("Chat", null, true, 0)).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "", slot: true },
    ]);
    expect(chatTrailEntries("Chat", null, false, 0)).toEqual([{ label: "Chat" }]);
  });
});
