// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { searchOf } from "../url-search.ts";

describe("searchOf", () => {
  it("writes the query behind its `?`", () => {
    expect(searchOf(new URLSearchParams({ preview: "file_1", q: "a b" }))).toBe(
      "?preview=file_1&q=a+b",
    );
  });

  it("is empty for no parameter, never a lone `?`", () => {
    expect(searchOf(new URLSearchParams())).toBe("");
  });
});
