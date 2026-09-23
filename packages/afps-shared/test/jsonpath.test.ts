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

  it.each([
    ["email", "must start with '$'"],
    ["", "must start with '$'"],
    ["$..email", "empty segment"],
    ["$.*", "wildcard"],
    ["$[*]", "unsupported jsonpath segment"],
    ["$[?(@.a)]", "unsupported jsonpath segment"],
    ["$[0:2]", "unsupported jsonpath segment"],
    ["$[0", "unterminated"],
    ["$email", "unexpected character"],
    ["$.data.0.id", "starting with a digit"],
  ])("rejects %p", (path, message) => {
    expect(() => parseJsonPath(path)).toThrow(JsonPathSyntaxError);
    expect(() => parseJsonPath(path)).toThrow(message);
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
