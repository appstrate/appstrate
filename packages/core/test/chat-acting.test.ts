// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { CHAT_ACTING_PERMISSIONS, chatActsIn } from "../src/chat-contract.ts";

describe("chatActsIn", () => {
  it("holds only when all three acting permissions do, from a Set or an array", () => {
    expect(chatActsIn(new Set(CHAT_ACTING_PERMISSIONS))).toBe(true);
    expect(chatActsIn([...CHAT_ACTING_PERMISSIONS, "agents:read"])).toBe(true);
    for (const missing of CHAT_ACTING_PERMISSIONS) {
      const rest = CHAT_ACTING_PERMISSIONS.filter((p) => p !== missing);
      expect(chatActsIn(new Set(rest))).toBe(false);
      expect(chatActsIn(rest)).toBe(false);
    }
    expect(chatActsIn([])).toBe(false);
  });
});
