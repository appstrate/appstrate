// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { mintSessionId } from "../src/ui/sessions.ts";

describe("mintSessionId", () => {
  it("matches the server chs_<uuidhex> shape", () => {
    expect(mintSessionId()).toMatch(/^chs_[0-9a-f]{32}$/);
  });

  it("is unique per call", () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintSessionId()));
    expect(ids.size).toBe(100);
  });
});
