// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { initials } from "../initials.ts";

describe("initials", () => {
  it("takes the first letter of the first two words of the name", () => {
    expect(initials("Ada  Lovelace King", "ada@example.com")).toBe("AL");
  });

  it("takes one letter from a one-word name", () => {
    expect(initials("ada", null)).toBe("A");
  });

  it("falls back to the email when the name is empty or blank", () => {
    expect(initials(null, "zoe@example.com")).toBe("Z");
    expect(initials("   ", "zoe@example.com")).toBe("Z");
  });

  it("keeps a letter outside the BMP whole", () => {
    expect(initials("𝒜da Byron", null)).toBe("𝒜B");
  });

  it("shows a question mark when there is nothing to read", () => {
    expect(initials(null, null)).toBe("?");
  });
});
