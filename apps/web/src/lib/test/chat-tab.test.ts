// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isChatTabShown } from "../chat-tab";

const base = { reachable: true, canWrite: false, previewing: false, hasOwnSessions: false };

describe("isChatTabShown", () => {
  it("shows the tab to a role that may write the chat", () => {
    expect(isChatTabShown({ ...base, canWrite: true })).toBe(true);
    expect(isChatTabShown({ ...base, canWrite: true, previewing: true })).toBe(true);
  });

  it("shows it to a reader only once it has conversations of its own", () => {
    expect(isChatTabShown({ ...base, hasOwnSessions: true })).toBe(true);
    expect(isChatTabShown({ ...base, hasOwnSessions: false })).toBe(false);
    expect(isChatTabShown({ ...base, hasOwnSessions: undefined })).toBe(false);
  });

  it("ignores the previewer's own conversations during a preview", () => {
    expect(isChatTabShown({ ...base, previewing: true, hasOwnSessions: true })).toBe(false);
  });

  it("never shows an unreachable chat", () => {
    expect(isChatTabShown({ ...base, reachable: false, canWrite: true })).toBe(false);
    expect(isChatTabShown({ ...base, reachable: false, hasOwnSessions: true })).toBe(false);
  });
});
