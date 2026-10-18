// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { proposalFromServer } from "../../../src/services/integration-server-sync.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1, 8, 6, 0, 0, 0,
]);
const tool = (name: string): Tool => ({ name, inputSchema: { type: "object" } });

function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = new Request(String(input)).url;
    seen.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("proposalFromServer", () => {
  it("proposes the tools alone when the server reports nothing else", async () => {
    const { fetchImpl } = fakeFetch({});
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "", version: "1" },
        instructions: "  ",
        tools: [tool("a"), tool("b"), tool("a")],
        truncated: false,
      },
      fetchImpl,
    );
    expect(proposal).toEqual({
      manifest: { default_tools: ["a", "b"], tools_policy: { a: {}, b: {} } },
      iconSource: null,
      instructions: null,
      provenance: { "/default_tools": "detected", "/tools_policy": "detected" },
      warnings: [],
    });
  });

  it("falls back to serverInfo.name, drops a non-http homepage, and warns on truncation", async () => {
    const { fetchImpl } = fakeFetch({});
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "acme-mcp", version: "1", websiteUrl: "javascript:alert(1)" },
        instructions: undefined,
        tools: [tool("a")],
        truncated: true,
      },
      fetchImpl,
    );
    expect(proposal.manifest.display_name).toBe("acme-mcp");
    expect(proposal.manifest.homepage).toBeUndefined();
    expect(proposal.warnings.map((w) => w.code)).toEqual(["tools_truncated"]);
  });

  it("caps the instructions at a line boundary, with a warning", async () => {
    const { fetchImpl } = fakeFetch({});
    const line = `${"é".repeat(99)}\n`;
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "x", version: "1" },
        instructions: line.repeat(200),
        tools: [],
        truncated: false,
      },
      fetchImpl,
    );
    const kept = Math.floor((32 * 1024) / new TextEncoder().encode(line).length);
    expect(proposal.instructions).toBe(line.repeat(kept).trimEnd());
    expect(proposal.warnings.map((w) => w.code)).toEqual(["instructions_truncated"]);
  });

  it("takes a fetched raster of serverInfo.icons before the site's icon", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "https://cdn.test/logo.png": () => new Response(PNG),
    });
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "x", version: "1", icons: [{ src: "https://cdn.test/logo.png" }] },
        instructions: undefined,
        tools: [],
        truncated: false,
      },
      fetchImpl,
    );
    const icon = `data:image/png;base64,${PNG.toBase64()}`;
    expect(proposal.iconSource).toBe(icon);
    expect(proposal.manifest.icon).toBe(icon);
    expect(seen).toEqual(["https://cdn.test/logo.png"]);
  });

  it("falls back to the site's icon when no server icon is a raster", async () => {
    const { fetchImpl } = fakeFetch({ "https://mcp.test/favicon.ico": () => new Response(PNG) });
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "x", version: "1", icons: [{ src: "https://cdn.test/missing.png" }] },
        instructions: undefined,
        tools: [],
        truncated: false,
      },
      fetchImpl,
    );
    expect(proposal.iconSource).toBe(`data:image/png;base64,${PNG.toBase64()}`);
  });
});
