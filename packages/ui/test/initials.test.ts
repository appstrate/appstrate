// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { initials } from "../src/initials.ts";

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Ada  Lovelace King")).toBe("AL");
  });

  it("takes one letter from a one-word label", () => {
    expect(initials("ada")).toBe("A");
  });

  it("keeps a letter outside the BMP whole", () => {
    expect(initials("𝒜da Byron")).toBe("𝒜B");
  });

  it("shows a question mark when there is nothing to read", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});
