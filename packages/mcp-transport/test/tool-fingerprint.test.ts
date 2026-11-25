// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { definitionApproved, toolDefinitionFingerprint } from "../src/tool-fingerprint.ts";

const base: Tool = {
  name: "search",
  title: "Search",
  description: "Search the index",
  inputSchema: {
    type: "object",
    properties: { q: { type: "string", description: "query" }, limit: { type: "number" } },
    required: ["q"],
  },
  outputSchema: { type: "object", properties: { hits: { type: "array" } } },
  annotations: { readOnlyHint: true },
};

describe("toolDefinitionFingerprint", () => {
  it("is a SHA-256 hex digest", () => {
    expect(toolDefinitionFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores key order, nested schemas included", () => {
    const reordered: Tool = {
      annotations: { readOnlyHint: true },
      outputSchema: { properties: { hits: { type: "array" } }, type: "object" },
      inputSchema: {
        required: ["q"],
        properties: { limit: { type: "number" }, q: { description: "query", type: "string" } },
        type: "object",
      },
      description: "Search the index",
      title: "Search",
      name: "search",
    };
    expect(toolDefinitionFingerprint(reordered)).toBe(toolDefinitionFingerprint(base));
  });

  it.each<[string, Partial<Tool>]>([
    ["name", { name: "find" }],
    ["description", { description: "Search the index, now with side effects" }],
    ["title", { title: "Find" }],
    [
      "inputSchema",
      { inputSchema: { type: "object", properties: { q: { type: "number" } }, required: ["q"] } },
    ],
    ["outputSchema", { outputSchema: { type: "object", properties: {} } }],
    ["annotations", { annotations: { readOnlyHint: false } }],
  ])("changes when %s changes", (_member, patch) => {
    expect(toolDefinitionFingerprint({ ...base, ...patch })).not.toBe(
      toolDefinitionFingerprint(base),
    );
  });

  it("ignores _meta and other extra fields", () => {
    const extra = { ...base, _meta: { ui: 1 }, icons: [{ src: "x" }], execution: {} } as Tool;
    expect(toolDefinitionFingerprint(extra)).toBe(toolDefinitionFingerprint(base));
  });

  it("treats an absent optional member like an undefined one", () => {
    const { title: _title, ...withoutTitle } = base;
    expect(toolDefinitionFingerprint({ ...withoutTitle, title: undefined })).toBe(
      toolDefinitionFingerprint(withoutTitle),
    );
  });

  it("does not throw on undefined nested in arrays or objects", () => {
    const odd = {
      ...base,
      inputSchema: { type: "object", enum: ["a", undefined], properties: { x: undefined } },
    } as unknown as Tool;
    expect(() => toolDefinitionFingerprint(odd)).not.toThrow();
  });
});

describe("definitionApproved", () => {
  it("approves any tool when there is no approval map", () => {
    expect(definitionApproved("search", "aaa", undefined)).toBe(true);
  });

  it("approves a tool absent from the map", () => {
    expect(definitionApproved("search", "aaa", { other: ["bbb"] })).toBe(true);
  });

  it("approves a tool whose fingerprint is among the approved ones", () => {
    expect(definitionApproved("search", "bbb", { search: ["aaa", "bbb"] })).toBe(true);
  });

  it("refuses a tool whose fingerprint is not approved", () => {
    expect(definitionApproved("search", "ccc", { search: ["aaa", "bbb"] })).toBe(false);
  });

  it("refuses a tool listed with no approved fingerprint", () => {
    expect(definitionApproved("search", "aaa", { search: [] })).toBe(false);
  });
});
