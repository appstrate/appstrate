// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { Context } from "hono";
import {
  paginate,
  projectFields,
  parseFieldSelection,
  parseListPagination,
} from "../../src/lib/list-query.ts";

/** Minimal Context stub exposing only `req.query(name)`. */
function fakeCtx(query: Record<string, string | undefined>): Context {
  return { req: { query: (name: string) => query[name] } } as unknown as Context;
}

describe("paginate", () => {
  const items = [1, 2, 3, 4, 5];

  it("slices a page and reports total + hasMore", () => {
    expect(paginate(items, { limit: 2, offset: 0 })).toEqual({
      page: [1, 2],
      total: 5,
      hasMore: true,
    });
  });

  it("reports hasMore false on the last page", () => {
    expect(paginate(items, { limit: 2, offset: 4 })).toEqual({
      page: [5],
      total: 5,
      hasMore: false,
    });
  });

  it("returns an empty page past the end", () => {
    expect(paginate(items, { limit: 2, offset: 10 })).toEqual({
      page: [],
      total: 5,
      hasMore: false,
    });
  });
});

describe("projectFields", () => {
  const row = { id: "a", manifest: { big: true }, source: "local" };

  it("returns the item untouched when fields is null", () => {
    expect(projectFields(row, null)).toBe(row);
  });

  it("keeps only requested fields", () => {
    expect(projectFields(row, new Set(["source"]), [])).toEqual({ source: "local" });
  });

  it("always keeps the `always` keys regardless of selection", () => {
    expect(projectFields(row, new Set(["source"]), ["id"])).toEqual({
      id: "a",
      source: "local",
    });
  });

  it("drops the heavy field when not requested", () => {
    const out = projectFields(row, new Set(["id"]), ["id"]);
    expect(out).not.toHaveProperty("manifest");
  });
});

describe("parseFieldSelection", () => {
  const allowed = ["id", "manifest", "source"] as const;

  it("returns null when the param is absent", () => {
    expect(parseFieldSelection(fakeCtx({}), allowed)).toBeNull();
  });

  it("returns null for an empty / whitespace-only param", () => {
    expect(parseFieldSelection(fakeCtx({ fields: "" }), allowed)).toBeNull();
    expect(parseFieldSelection(fakeCtx({ fields: " , " }), allowed)).toBeNull();
  });

  it("parses and trims a comma-separated list", () => {
    const set = parseFieldSelection(fakeCtx({ fields: " id , source " }), allowed);
    expect(set).toEqual(new Set(["id", "source"]));
  });

  it("throws a 400 naming the unknown field", () => {
    expect(() => parseFieldSelection(fakeCtx({ fields: "id,bogus" }), allowed)).toThrow(/bogus/);
  });
});

describe("parseListPagination", () => {
  it("applies defaults when params are absent", () => {
    expect(parseListPagination(fakeCtx({}), { defaultLimit: 100 })).toEqual({
      limit: 100,
      offset: 0,
    });
  });

  it("parses valid limit/offset", () => {
    expect(
      parseListPagination(fakeCtx({ limit: "10", offset: "20" }), { defaultLimit: 100 }),
    ).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it("falls back to the default for an out-of-range or garbage limit", () => {
    expect(parseListPagination(fakeCtx({ limit: "9999" }), { defaultLimit: 50 }).limit).toBe(50);
    expect(parseListPagination(fakeCtx({ limit: "abc" }), { defaultLimit: 50 }).limit).toBe(50);
  });

  it("clamps a negative offset back to 0", () => {
    expect(parseListPagination(fakeCtx({ offset: "-5" }), { defaultLimit: 50 }).offset).toBe(0);
  });
});
