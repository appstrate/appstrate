// SPDX-License-Identifier: Apache-2.0

/** The requests « Tout marquer comme lu » sends: one per space the list spans. */

import { describe, expect, it } from "bun:test";
import { markAllRunsReadRequests } from "../mark-all-runs-read.ts";

describe("markAllRunsReadRequests", () => {
  it("marks the working space's runs in one request the client scopes", () => {
    expect(markAllRunsReadRequests(null)).toEqual([{}]);
  });

  it("marks each spanned space's runs in a request naming it", () => {
    expect(markAllRunsReadRequests(["spc_a", "spc_b"])).toEqual([
      { header: { "X-Space-Id": "spc_a" } },
      { header: { "X-Space-Id": "spc_b" } },
    ]);
  });

  it("sends nothing when the list spans no space", () => {
    expect(markAllRunsReadRequests([])).toEqual([]);
  });
});
