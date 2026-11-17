// SPDX-License-Identifier: Apache-2.0

/** The chat's trail: the conversation's name, a slot while it loads, the chat alone otherwise. */

import { describe, expect, it } from "bun:test";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
  location: { pathname: "/", origin: "http://localhost" },
});

const { chatTrailEntries } = await import("./chat-crumb-title.ts");

describe("chatTrailEntries", () => {
  it("is the chat and the conversation's name, without the spaces it touched", () => {
    expect(chatTrailEntries("Chat", "Budget", false)).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "Budget" },
    ]);
  });

  it("holds the name's slot while loading and falls back to the chat alone", () => {
    expect(chatTrailEntries("Chat", null, true)).toEqual([
      { label: "Chat", href: "/chat" },
      { label: "", slot: true },
    ]);
    expect(chatTrailEntries("Chat", null, false)).toEqual([{ label: "Chat" }]);
  });
});
