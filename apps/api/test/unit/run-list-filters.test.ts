// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { parseRunListFilters, runSearchCondition } from "../../src/lib/run-list-filters.ts";

describe("run list filters", () => {
  it("leaves an unfiltered request unfiltered", () => {
    expect(parseRunListFilters({})).toEqual({ status: undefined, search: undefined });
    expect(parseRunListFilters({ status: "", q: "  " })).toEqual({
      status: undefined,
      search: undefined,
    });
  });
  it("normalizes and deduplicates lifecycle statuses", () => {
    expect(parseRunListFilters({ status: "failed, timeout,failed", q: " #129 " })).toEqual({
      status: ["failed", "timeout"],
      search: "#129",
    });
  });
  it("rejects any unknown status instead of widening the result", () => {
    expect(() => parseRunListFilters({ status: "failed,typo" })).toThrow();
    expect(() => parseRunListFilters({ status: "failed," })).toThrow();
  });
  it("bounds the free-text search", () => {
    expect(() => parseRunListFilters({ q: "x".repeat(201) })).toThrow();
    expect(parseRunListFilters({ q: "x".repeat(200) }).search).toHaveLength(200);
  });
  it("binds literal wildcard characters rather than interpolating SQL", () => {
    const query = new PgDialect().sqlToQuery(runSearchCondition("50%_off"));
    expect(query.params).toEqual(["%50\\%\\_off%", "%50\\%\\_off%", "%50\\%\\_off%"]);
    expect(query.sql).not.toContain("50%");
  });
  it("escapes backslashes", () => {
    const query = new PgDialect().sqlToQuery(runSearchCondition("a\\b"));
    expect(query.params[0]).toBe("%a\\\\b%");
  });
  it("also matches positive run numbers, with or without a hash", () => {
    for (const input of ["129", "#129"]) {
      const query = new PgDialect().sqlToQuery(runSearchCondition(input));
      expect(query.params.at(-1)).toBe(129);
      expect(query.sql).toContain('"run_number"');
    }
  });
});
