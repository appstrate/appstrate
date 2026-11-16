// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { chatActsIn } from "../src/chat-contract.ts";

const ACTING = ["chat:write", "chat:read", "mcp:read"];

describe("chatActsIn", () => {
  it("holds only when all three acting permissions do", () => {
    expect(chatActsIn([...ACTING, "agents:read"])).toBe(true);
    for (const missing of ACTING) {
      expect(chatActsIn(ACTING.filter((p) => p !== missing))).toBe(false);
    }
    expect(chatActsIn([])).toBe(false);
  });
});
