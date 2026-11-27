// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  declarableTools,
  declareTools,
  hasOAuthAuth,
  isToolWithoutPermission,
  isUsableToolStatus,
  latestApprovals,
  reviewItems,
  toolHints,
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
  { name: "declared", status: "available" as const },
  { name: "search", status: "pending" as const },
  { name: "export", status: "blocked" as const },
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
      {
        name: "export",
        fingerprint: "fp-e",
        definition: null,
        description: null,
        hints: { readOnly: false, destructive: false },
        approved: null,
      },
    ]);
  });
});

describe("toolHints", () => {
  it("reads only literal true hints from the server's annotations", () => {
    expect(toolHints({ annotations: { readOnlyHint: true, destructiveHint: false } })).toEqual({
      readOnly: true,
      destructive: false,
    });
    expect(toolHints({ annotations: { destructiveHint: true } })).toEqual({
      readOnly: false,
      destructive: true,
    });
    for (const definition of [null, {}, { annotations: null }, { annotations: "x" }]) {
      expect(toolHints(definition)).toEqual({ readOnly: false, destructive: false });
    }
    expect(toolHints({ annotations: { readOnlyHint: "true", destructiveHint: 1 } })).toEqual({
      readOnly: false,
      destructive: false,
    });
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

describe("declarableTools", () => {
  it("keeps the tools the integration does not declare, minus those the server no longer lists", () => {
    expect(
      declarableTools([
        { name: "a", origin: "declared" },
        { name: "b", origin: "listed" },
        { name: "c", origin: "approved" },
        { name: "d" },
        { name: "gone", origin: "approved", status: "missing" },
        { name: "here", origin: "listed", status: "pending" },
      ]),
    ).toEqual(["b", "c", "d", "here"]);
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

describe("isToolWithoutPermission", () => {
  it("holds for an available tool whatever its origin, with no scope listed", () => {
    expect(isToolWithoutPermission({})).toBe(true);
    expect(isToolWithoutPermission({ status: "available", permissions: {} })).toBe(true);
    expect(isToolWithoutPermission({ status: "available", permissions: { a: [] } })).toBe(true);
  });

  it("fails for a tool with a scope or one an agent cannot call", () => {
    expect(isToolWithoutPermission({ permissions: { a: ["read"] } })).toBe(false);
    expect(isToolWithoutPermission({ status: "pending" })).toBe(false);
  });
});

describe("hasOAuthAuth", () => {
  it("is true only for an OAuth auth", () => {
    expect(hasOAuthAuth([{ type: "api_key" }, { type: "oauth2" }])).toBe(true);
    expect(hasOAuthAuth([{ type: "api_key" }, { type: "basic" }])).toBe(false);
    expect(hasOAuthAuth([])).toBe(false);
  });
});

describe("isUsableToolStatus", () => {
  it("is true without a verdict or when available, false for the other statuses", () => {
    expect(isUsableToolStatus(undefined)).toBe(true);
    expect(isUsableToolStatus("available")).toBe(true);
    for (const status of ["missing", "pending", "blocked"] as const) {
      expect(isUsableToolStatus(status)).toBe(false);
    }
  });
});
