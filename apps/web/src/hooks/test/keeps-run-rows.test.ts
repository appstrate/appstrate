// SPDX-License-Identifier: Apache-2.0

/** Which key changes keep a run list's rows on screen while the next key loads. */

import { describe, it, expect } from "bun:test";
import { ACROSS_SPACES, paginatedRunsKeys } from "../../lib/query-keys.ts";
import { keepsRunRows } from "../use-paginated-runs.ts";

const key = (
  overrides: {
    status?: string;
    search?: string;
    limit?: number;
    spaceKind?: "team" | "personal";
  } = {},
) =>
  paginatedRunsKeys.list(
    "org_1",
    "spc_1",
    "/runs",
    undefined,
    undefined,
    overrides.status,
    undefined,
    overrides.search ?? "",
    overrides.limit ?? 25,
    overrides.spaceKind,
  );

describe("keepsRunRows", () => {
  it("drops the rows when the page size changes", () => {
    expect(keepsRunRows(key({ limit: 25 }), key({ limit: 1 }))).toBe(false);
  });

  it("keeps the rows while the search changes, so typing never flashes a skeleton", () => {
    expect(keepsRunRows(key({ search: "rap" }), key({ search: "rapport" }))).toBe(true);
  });

  it("drops the rows when the space kind changes, and keeps them while searching within it", () => {
    expect(keepsRunRows(key({ spaceKind: "team" }), key())).toBe(false);
    expect(
      keepsRunRows(
        key({ spaceKind: "team", search: "r" }),
        key({ spaceKind: "team", search: "ra" }),
      ),
    ).toBe(true);
  });

  it("drops the rows when a filter changes", () => {
    expect(keepsRunRows(key(), key({ status: "failed" }))).toBe(false);
  });

  it("treats a list across spaces like any list: searching keeps, entering or leaving it drops", () => {
    const across = (search = "") =>
      paginatedRunsKeys.list(
        "org_1",
        ACROSS_SPACES,
        "/runs",
        undefined,
        undefined,
        undefined,
        undefined,
        search,
        20,
      );
    expect(keepsRunRows(across(), across("rap"))).toBe(true);
    expect(keepsRunRows(key(), across())).toBe(false);
    expect(keepsRunRows(across(), key())).toBe(false);
  });
});
