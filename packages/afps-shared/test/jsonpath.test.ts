// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { evaluateJsonPath, JsonPathSyntaxError, parseJsonPath } from "../src/jsonpath.ts";

const doc = {
  email: "a@b.c",
  user: { id: 7, "display name": "Ada" },
  data: [{ primaryEmail: "first@x" }, { primaryEmail: "last@x" }],
};

describe("parseJsonPath", () => {
  it("tokenizes members, quoted members and indices", () => {
    expect(parseJsonPath("$")).toEqual([]);
    expect(parseJsonPath("$.user.id")).toEqual(["user", "id"]);
    expect(parseJsonPath(`$['display name']["x"][0][-1]`)).toEqual(["display name", "x", 0, -1]);
  });

  it.each<[string, (string | number)[]]>([
    ["$._a1", ["_a1"]],
    ["$.é.日本", ["é", "日本"]],
    ["$.a1_B", ["a1_B"]],
    ["$['a]b']", ["a]b"]],
    ["$['a.b[0]']", ["a.b[0]"]],
    [`$["a','b"]`, ["a','b"]],
    [String.raw`$['x\'y']`, ["x'y"]],
    [String.raw`$["x\"y"]`, ['x"y']],
    [`$['"']`, ['"']],
    [`$["'"]`, ["'"]],
    [String.raw`$['\\\/\b\f\n\r\t']`, ["\\/\b\f\n\r\t"]],
    [String.raw`$['é']`, ["é"]],
    ["$['\\uD83D\\uDE00']", ["\u{1F600}"]],
    ["$['']", [""]],
    ["$[ 'a' ][ 0 ]", ["a", 0]],
    ["$[0]", [0]],
    ["$[-1]", [-1]],
  ])("accepts %p", (path, segments) => {
    expect(parseJsonPath(path)).toEqual(segments);
  });

  it.each([
    ["email", "must start with '$'"],
    ["", "must start with '$'"],
    ["$..email", "recursive descent"],
    ["$.", "expected a member name"],
    ["$.*", "wildcard"],
    ["$[*]", "unsupported selector"],
    ["$[?(@.a)]", "unsupported selector"],
    ["$[0:2]", "slice"],
    ["$[0", "unterminated '['"],
    ["$['a", "unterminated string"],
    ["$email", "unexpected character"],
    ["$.data.0.id", "cannot start with a digit"],
    ["$['a','b']", "union"],
    ["$.a]", "unexpected character ']'"],
    ["$.a b", "unexpected character ' '"],
    ["$.a-b", "unexpected character '-'"],
    ["$.arr[-0]", "not an RFC 9535 int"],
    ["$.arr[01]", "not an RFC 9535 int"],
    ["$.arr[-]", "expected an index"],
    ["$[9007199254740992]", "out of range"],
    ["$[0 1]", "expected ']'"],
    ["$['a' 'b']", "expected ']'"],
    [String.raw`$['\q']`, "invalid escape"],
    [String.raw`$['\"']`, "invalid escape"],
    [String.raw`$["\'"]`, "invalid escape"],
    [String.raw`$['\u12']`, "4 hex digits"],
    [String.raw`$['\uD83D']`, "without a low surrogate"],
    [String.raw`$['\uDE00']`, "lone low surrogate"],
    ["$['a\nb']", "control character"],
  ])("rejects %p", (path, message) => {
    expect(() => parseJsonPath(path)).toThrow(JsonPathSyntaxError);
    expect(() => parseJsonPath(path)).toThrow(message);
  });

  it("reports the offset of the offending character", () => {
    expect(() => parseJsonPath("$.a b")).toThrow("at offset 3");
    expect(() => parseJsonPath("$.arr[01]")).toThrow("at offset 6");
  });
});

describe("evaluateJsonPath", () => {
  it("selects nested members, quoted members and indices", () => {
    expect(evaluateJsonPath(doc, "$")).toBe(doc);
    expect(evaluateJsonPath(doc, "$.email")).toBe("a@b.c");
    expect(evaluateJsonPath(doc, "$.user['display name']")).toBe("Ada");
    expect(evaluateJsonPath(doc, "$.data[0].primaryEmail")).toBe("first@x");
    expect(evaluateJsonPath(doc, "$.data[-1].primaryEmail")).toBe("last@x");
  });

  it("applies a member only to an object and an index only to an array", () => {
    expect(evaluateJsonPath(doc, "$.data['0']")).toBeUndefined();
    expect(evaluateJsonPath(doc, "$.data.length")).toBeUndefined();
    expect(evaluateJsonPath({ "0": "zero" }, "$['0']")).toBe("zero");
  });

  it("returns undefined for a valid path that selects nothing", () => {
    expect(evaluateJsonPath(doc, "$.missing")).toBeUndefined();
    expect(evaluateJsonPath(doc, "$.email.deeper")).toBeUndefined();
    expect(evaluateJsonPath(doc, "$.data[5]")).toBeUndefined();
    expect(evaluateJsonPath(doc, "$.data[-5]")).toBeUndefined();
    expect(evaluateJsonPath(doc, "$.user[0]")).toBeUndefined();
  });

  it("never reaches the prototype chain", () => {
    expect(evaluateJsonPath(doc, "$.constructor")).toBeUndefined();
    expect(evaluateJsonPath(doc, "$.__proto__")).toBeUndefined();
  });

  it("throws on an invalid path even when the document is empty", () => {
    expect(() => evaluateJsonPath({}, "email")).toThrow(JsonPathSyntaxError);
  });
});
