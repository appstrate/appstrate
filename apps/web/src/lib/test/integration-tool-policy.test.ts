// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import {
  approvalBody,
  blockBody,
  blockableTools,
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
