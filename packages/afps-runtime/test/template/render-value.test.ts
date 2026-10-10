// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import { renderValue } from "../../src/template/render-value.ts";

describe("renderValue", () => {
  it("returns strings unchanged", () => {
    expect(renderValue("vans")).toBe("vans");
    expect(renderValue('say "hi"')).toBe('say "hi"');
  });

  it("renders numbers, booleans and null like String()", () => {
    expect(renderValue(42)).toBe("42");
    expect(renderValue(true)).toBe("true");
    expect(renderValue(false)).toBe("false");
    expect(renderValue(null)).toBe("null");
  });

  it("renders objects as JSON", () => {
    expect(renderValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  it("renders nested objects as JSON", () => {
    expect(renderValue({ a: { b: [1, { c: null }] } })).toBe('{"a":{"b":[1,{"c":null}]}}');
  });

  it("keeps array elements unambiguous when they contain commas", () => {
    expect(renderValue(["a,b", "c"])).toBe('["a,b","c"]');
  });

  it("renders arrays of objects as JSON", () => {
    expect(renderValue([{ id: 1 }, { id: 2 }])).toBe('[{"id":1},{"id":2}]');
  });
});
