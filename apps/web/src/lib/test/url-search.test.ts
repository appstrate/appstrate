// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { hrefWithSearch, searchOf } from "../url-search.ts";

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

describe("hrefWithSearch", () => {
  it("keeps the path and the hash around the new query", () => {
    const location = { pathname: "/runs/run_1", hash: "#results" };
    expect(hrefWithSearch(location, new URLSearchParams({ preview: "file_1" }))).toBe(
      "/runs/run_1?preview=file_1#results",
    );
    expect(hrefWithSearch(location, new URLSearchParams())).toBe("/runs/run_1#results");
  });
});
