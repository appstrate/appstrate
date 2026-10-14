// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { likeContains } from "../../src/lib/like-pattern.ts";

describe("likeContains", () => {
  it("wraps the text in wildcards and escapes the caller's own", () => {
    expect(likeContains("report")).toBe("%report%");
    expect(likeContains("50%_off")).toBe("%50\\%\\_off%");
    expect(likeContains("a\\b")).toBe("%a\\\\b%");
  });
});
