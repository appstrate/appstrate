// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  approvalBody,
  blockBody,
  blockableTools,
  canonicalDefinitionJson,
  declarableTools,
  declareTools,
  latestApprovals,
  reviewItems,
  type ToolPolicy,
} from "../integration-tool-policy";

const policy: Pick<ToolPolicy, "listed" | "approvals" | "blocks"> = {
  listed: [
    { name: "search", fingerprint: "fp-new", definition: { description: "Search pages" } },
    { name: "search", fingerprint: "fp-old", definition: { description: "Search" } },
    { name: "export", fingerprint: "fp-e", definition: null },
    { name: "declared", fingerprint: "fp-d", definition: {} },
  ],
  approvals: [
    {
      tool_name: "search",
      fingerprint: "fp-old",
      definition: { description: "Search" },
      approved_by: null,
      approved_at: "2026-11-01T00:00:00.000Z",
    },
  ],
  blocks: [{ tool_name: "export", blocked_by: null, blocked_at: "2026-11-02T00:00:00.000Z" }],
};
const catalog = [
  { name: "declared", status: "available" },
  { name: "search", status: "pending" },
  { name: "export", status: "blocked" },
];

describe("reviewItems", () => {
  it("lists pending tools' definitions no approval covers, with the one they replace", () => {
    const items = reviewItems(catalog, policy);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "search",
      fingerprint: "fp-new",
      description: "Search pages",
      approved: { fingerprint: "fp-old", definition: { description: "Search" } },
    });
  });

  it("keeps a tool whose definition was too large, and skips non-pending tools", () => {
    const items = reviewItems([{ name: "export", status: "pending" }], policy);
    expect(items).toEqual([
      { name: "export", fingerprint: "fp-e", definition: null, description: null, approved: null },
    ]);
  });
});

describe("latestApprovals / newest approval", () => {
  const approval = (fingerprint: string, approved_at: string, description: string) => ({
    tool_name: "search",
    fingerprint,
    definition: { description },
    approved_by: null,
    approved_at,
  });

  it("keeps the newest approval of a tool, whatever the order", () => {
    const approvals = [
      approval("fp-b", "2026-11-05T00:00:00.000Z", "B"),
      approval("fp-a", "2026-11-01T00:00:00.000Z", "A"),
    ];
    expect(latestApprovals(approvals).get("search")?.fingerprint).toBe("fp-b");
    const items = reviewItems([{ name: "search", status: "pending" }], {
      listed: [{ name: "search", fingerprint: "fp-c", definition: {} }],
      approvals,
    });
    expect(items[0]?.approved).toEqual({ fingerprint: "fp-b", definition: { description: "B" } });
  });
});

describe("a pending tool no listing carries", () => {
  it("is reviewed without a fingerprint, so there is nothing to approve yet", () => {
    expect(
      reviewItems([{ name: "ghost", status: "pending" }], { listed: [], approvals: [] }),
    ).toEqual([
      { name: "ghost", fingerprint: null, definition: null, description: null, approved: null },
    ]);
  });
});

describe("canonicalDefinitionJson", () => {
  it("sorts keys at every depth", () => {
    expect(canonicalDefinitionJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(
      canonicalDefinitionJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }),
    );
    expect(canonicalDefinitionJson({ b: 1, a: 2 }).indexOf('"a"')).toBeLessThan(
      canonicalDefinitionJson({ b: 1, a: 2 }).indexOf('"b"'),
    );
  });
});

describe("bodies", () => {
  it("pins the payloads the writes send", () => {
    expect(approvalBody({ name: "search", fingerprint: "fp-new" })).toEqual({
      tools: [{ name: "search", fingerprint: "fp-new" }],
    });
    expect(blockBody("search")).toEqual({ tools: ["search"] });
  });

  it("offers only tools not blocked yet", () => {
    expect(blockableTools(catalog, policy.blocks)).toEqual(["declared", "search"]);
  });
});

describe("declarableTools", () => {
  it("keeps the tools the integration does not declare", () => {
    expect(
      declarableTools([
        { name: "a", origin: "declared" },
        { name: "b", origin: "listed" },
        { name: "c", origin: "approved" },
        { name: "d" },
      ]),
    ).toEqual(["b", "c", "d"]);
  });
});

describe("declareTools", () => {
  it("appends an empty entry per undeclared name, keeping everything else", () => {
    const manifest = {
      name: "x",
      default_tools: ["a"],
      tools_policy: { a: { required_scopes: ["s"] } },
    };
    const next = declareTools(manifest, ["b", "a", "c"]);
    expect(next).toEqual({
      name: "x",
      default_tools: ["a"],
      tools_policy: { a: { required_scopes: ["s"] }, b: {}, c: {} },
    });
    expect(Object.keys(next.tools_policy as object)).toEqual(["a", "b", "c"]);
    expect(manifest.tools_policy).toEqual({ a: { required_scopes: ["s"] } });
  });

  it("creates tools_policy when absent and is a no-op when all are declared", () => {
    expect(declareTools({ name: "x" }, ["b"])).toEqual({ name: "x", tools_policy: { b: {} } });
    const manifest = { tools_policy: { a: {} } };
    expect(declareTools(manifest, ["a"])).toBe(manifest);
  });
});
