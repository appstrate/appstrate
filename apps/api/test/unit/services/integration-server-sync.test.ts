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
      manifest: { default_tools: [], tools_policy: { a: {}, b: {} } },
      iconSource: null,
      instructions: null,
      tools: [
        { name: "a", readOnly: false, destructive: false },
        { name: "b", readOnly: false, destructive: false },
      ],
      warnings: [],
    });
  });

  it("pre-selects only the tools annotated readOnlyHint: true, listing every tool", async () => {
    const { fetchImpl } = fakeFetch({});
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "x", version: "1" },
        instructions: undefined,
        tools: [
          { ...tool("read"), title: " Read ", annotations: { readOnlyHint: true } },
          { ...tool("write"), description: "Writes.", annotations: { readOnlyHint: false } },
          { ...tool("titled"), annotations: { title: "From annotations", readOnlyHint: true } },
          { ...tool("bare"), title: "", description: "   " },
          { ...tool("destroy"), annotations: { destructiveHint: true } },
          // Both hints: never pre-selected, whatever the read-only one says.
          { ...tool("purge"), annotations: { readOnlyHint: true, destructiveHint: true } },
        ],
        truncated: false,
      },
      fetchImpl,
    );
    expect(proposal.manifest.default_tools).toEqual(["read", "titled"]);
    expect(Object.keys(proposal.manifest.tools_policy as object)).toEqual([
      "read",
      "write",
      "titled",
      "bare",
      "destroy",
      "purge",
    ]);
    expect(proposal.tools).toEqual([
      { name: "read", title: "Read", readOnly: true, destructive: false },
      { name: "write", description: "Writes.", readOnly: false, destructive: false },
      { name: "titled", title: "From annotations", readOnly: true, destructive: false },
      { name: "bare", readOnly: false, destructive: false },
      { name: "destroy", readOnly: false, destructive: true },
      { name: "purge", readOnly: true, destructive: true },
    ]);
  });

  it("caps a tool's title and description, never splitting a code point", async () => {
    const { fetchImpl } = fakeFetch({});
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "x", version: "1" },
        instructions: undefined,
        tools: [{ ...tool("long"), title: "t".repeat(500), description: "😀".repeat(2000) }],
        truncated: false,
      },
      fetchImpl,
    );
    const [long] = proposal.tools;
    expect(long?.title).toBe(`${"t".repeat(199)}…`);
    expect(long?.description).toBe(`${"😀".repeat(1023)}…`);
    expect([...(long?.description ?? "")]).toHaveLength(1024);
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
      "https://mcp.test/logo.png": () => new Response(PNG),
    });
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.test/mcp",
        info: { name: "x", version: "1", icons: [{ src: "https://mcp.test/logo.png" }] },
        instructions: undefined,
        tools: [],
        truncated: false,
      },
      fetchImpl,
    );
    const icon = `data:image/png;base64,${PNG.toBase64()}`;
    expect(proposal.iconSource).toBe(icon);
    expect(proposal.manifest.icon).toBe(icon);
    expect(seen).toEqual(["https://mcp.test/logo.png"]);
  });

  it("never fetches a server icon of another origin, plaintext or not", async () => {
    const { fetchImpl, seen } = fakeFetch({
      "http://tracker.example/icon.png": () => new Response(PNG),
      "https://cdn.example/icon.png": () => new Response(PNG),
    });
    const proposal = await proposalFromServer(
      {
        url: "https://mcp.example/mcp",
        info: {
          name: "MCP",
          version: "1",
          icons: [
            { src: "http://tracker.example/icon.png" },
            { src: "https://cdn.example/icon.png" },
          ],
        },
        instructions: undefined,
        tools: [],
        truncated: false,
      },
      fetchImpl,
    );
    expect(proposal.iconSource).toBeNull();
    expect(seen).not.toContain("http://tracker.example/icon.png");
    expect(seen).not.toContain("https://cdn.example/icon.png");
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
