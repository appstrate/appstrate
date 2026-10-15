// SPDX-License-Identifier: Apache-2.0

/** Which key changes keep a run list's rows on screen while the next page loads. */

import { describe, it, expect } from "bun:test";
import { paginatedRunsKeys } from "../../lib/query-keys.ts";
import { keepsRunRows } from "../use-paginated-runs.ts";

const key = (overrides: { status?: string; search?: string; offset?: number } = {}) =>
  paginatedRunsKeys.list(
    "org_1",
    "spc_1",
    "/runs",
    undefined,
    undefined,
    overrides.status,
    overrides.search ?? "",
    20,
    overrides.offset ?? 0,
  );

describe("keepsRunRows", () => {
  it("keeps the rows while paging", () => {
    expect(keepsRunRows(key({ offset: 0 }), key({ offset: 20 }))).toBe(true);
  });

  it("keeps the rows while the search changes, so typing never flashes a skeleton", () => {
    expect(keepsRunRows(key({ search: "rap" }), key({ search: "rapport" }))).toBe(true);
  });

  it("drops the rows when a filter changes", () => {
    expect(keepsRunRows(key(), key({ status: "failed" }))).toBe(false);
  });
});
