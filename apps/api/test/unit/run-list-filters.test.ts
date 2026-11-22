// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Context } from "hono";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AppEnv } from "../../src/types/index.ts";
import {
  parseGlobalRunListQuery,
  parseRunListFilters,
  runSearchCondition,
} from "../../src/lib/run-list-filters.ts";

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
    // Measured as sent, the bound the OpenAPI `maxLength` states.
    expect(() => parseRunListFilters({ q: ` ${"x".repeat(200)}` })).toThrow();
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
  it("matches no run number outside int4 or spelled other than as digits", () => {
    for (const input of ["99999999999", "2147483648", "1e20", "1e3", "0x10", "0", "-5"]) {
      const query = new PgDialect().sqlToQuery(runSearchCondition(input));
      expect(query.sql).not.toContain('"run_number"');
    }
    const largest = new PgDialect().sqlToQuery(runSearchCondition("2147483647"));
    expect(largest.params.at(-1)).toBe(2147483647);
  });
});

describe("space_kind filter", () => {
  const parse = (query: Record<string, string>) =>
    parseGlobalRunListQuery({
      req: { query: (name?: string) => (name ? query[name] : query) },
    } as unknown as Context<AppEnv>);
  it("reads absent and empty as no narrowing", () => {
    expect(parse({}).spaceKind).toBeUndefined();
    expect(parse({ space_kind: "" }).spaceKind).toBeUndefined();
  });
  it("accepts the two kinds", () => {
    expect(parse({ space_kind: "team" }).spaceKind).toBe("team");
    expect(parse({ space_kind: "personal" }).spaceKind).toBe("personal");
  });
  it("rejects any other value instead of widening the list", () => {
    expect(() => parse({ space_kind: "all" })).toThrow();
    expect(() => parse({ space_kind: "Team" })).toThrow();
  });
});

describe("spaceId filter", () => {
  const A = "spc_00000000-0000-4000-8000-000000000001";
  const B = "spc_00000000-0000-4000-8000-000000000002";
  const parse = (query: Record<string, string>) =>
    parseGlobalRunListQuery({
      req: { query: (name?: string) => (name ? query[name] : query) },
    } as unknown as Context<AppEnv>);
  const ids = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `spc_00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
  it("reads absent and empty as no narrowing", () => {
    expect(parse({}).spaceIds).toBeUndefined();
    expect(parse({ spaceId: "" }).spaceIds).toBeUndefined();
  });
  it("accepts one or several ids and collapses a repeated one", () => {
    expect(parse({ spaceId: A }).spaceIds).toEqual([A]);
    expect(parse({ spaceId: `${A}, ${B},${A}` }).spaceIds).toEqual([A, B]);
  });
  it("rejects a malformed member instead of dropping it", () => {
    expect(() => parse({ spaceId: `${A},nope` })).toThrow();
    expect(() => parse({ spaceId: `${A},` })).toThrow();
  });
  it("caps the list at 100 ids", () => {
    expect(parse({ spaceId: ids(100).join(",") }).spaceIds).toHaveLength(100);
    expect(() => parse({ spaceId: ids(101).join(",") })).toThrow();
  });
});
