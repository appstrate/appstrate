// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { jsonText } from "../src/json-text.ts";

describe("jsonText", () => {
  it("returns strings unchanged", () => {
    expect(jsonText("vans")).toBe("vans");
    expect(jsonText('say "hi"')).toBe('say "hi"');
  });

  it("renders numbers, booleans and null like String()", () => {
    expect(jsonText(42)).toBe("42");
    expect(jsonText(true)).toBe("true");
    expect(jsonText(false)).toBe("false");
    expect(jsonText(null)).toBe("null");
  });

  it("renders objects as JSON", () => {
    expect(jsonText({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(jsonText({ a: { b: [1, { c: null }] } })).toBe('{"a":{"b":[1,{"c":null}]}}');
  });

  it("keeps array elements unambiguous when they contain commas", () => {
    expect(jsonText(["a,b", "c"])).toBe('["a,b","c"]');
    expect(jsonText([{ id: 1 }, { id: 2 }])).toBe('[{"id":1},{"id":2}]');
  });
});
