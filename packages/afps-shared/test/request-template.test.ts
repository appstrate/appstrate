// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import {
  headerNamed,
  placeholderBodyEncoding,
  placeholderKeys,
  urlTemplateAuthority,
  type BodyEncoding,
} from "../src/request-template.ts";

describe("placeholderKeys", () => {
  it("lists each {{name}}, spaces tolerated, in order", () => {
    expect(placeholderKeys("{{a}}/{{ b }}?c={{a}}")).toEqual(["a", "b", "a"]);
    expect(placeholderKeys("{a} {{a-b}} {{}}")).toEqual([]);
  });
});

describe("headerNamed", () => {
  it("finds a header whatever its case", () => {
    expect(headerNamed({ "content-TYPE": "a/b" }, "content-type")).toBe("a/b");
    expect(headerNamed({ Accept: "a/b" }, "content-type")).toBeUndefined();
  });
});

describe("urlTemplateAuthority", () => {
  it.each([
    [
      "https://{{tenant}}.example.com:{{port}}/v1/{{id}}?q=1",
      "https://{{tenant}}.example.com:{{port}}",
    ],
    ["https://h.example?q=/x", "https://h.example"],
    ["https://h.example#/x", "https://h.example"],
    ["{{base}}/v1/{{id}}", "{{base}}"],
    ["{{base}}{{path}}", "{{base}}{{path}}"],
    ["/v1/{{id}}", ""],
  ])("%s → %s", (template, authority) => {
    expect(urlTemplateAuthority(template)).toBe(authority);
  });
});

describe("placeholderBodyEncoding", () => {
  it.each<[string, BodyEncoding]>([
    ["application/json; charset=utf-8", { kind: "json" }],
    ["application/vnd.api+json", { kind: "json" }],
    ["application/x-ndjson", { kind: "json" }],
    ["application/x-www-form-urlencoded", { kind: "form" }],
    ["application/soap+xml", { kind: "xml" }],
    ["text/plain", { kind: "text" }],
    ["multipart/form-data; boundary=B", { kind: "multipart", boundary: "B" }],
    ['multipart/form-data; boundary="a b"', { kind: "multipart", boundary: "a b" }],
  ])("%s has an encoder", (contentType, encoding) => {
    expect(placeholderBodyEncoding(contentType)).toEqual({ encoding });
  });

  it.each([undefined, "application/graphql", "multipart/form-data", "{{ct}}", "application/{{t}}"])(
    "%s has none, and the issue names a written type only",
    (contentType) => {
      const result = placeholderBodyEncoding(contentType);
      if (!("issue" in result)) throw new Error("encoded");
      expect(result.issue).toContain("Content-Type");
    },
  );
});
