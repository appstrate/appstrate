// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { isMcpOperationExchange, mcpFetch } from "../src/index.ts";

describe("mcpFetch", () => {
  it("hands the URL and init to the sender", async () => {
    const seen: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchLike = mcpFetch(async (url, init) => {
      seen.push([url, init]);
      return new Response("ok");
    });
    const init = { method: "POST", body: "{}" };
    expect(await (await fetchLike("https://mcp.example.com/mcp", init)).text()).toBe("ok");
    expect(seen).toEqual([["https://mcp.example.com/mcp", init]]);
  });

  it("refuses a Request, whose method and body the sender would not see", async () => {
    let sent = 0;
    const fetchLike = mcpFetch(async () => {
      sent += 1;
      return new Response();
    });
    await expect(
      fetchLike(new Request("https://mcp.example.com/mcp", { method: "POST", body: "{}" })),
    ).rejects.toThrow("an MCP fetch takes a URL, not a Request");
    expect(sent).toBe(0);
  });
});

describe("isMcpOperationExchange", () => {
  it("is a tools/call or tools/list request", () => {
    const req = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method });
    expect(isMcpOperationExchange(req("tools/call"))).toBe(true);
    expect(isMcpOperationExchange(req("tools/list"))).toBe(true);
    expect(isMcpOperationExchange(req("initialize"))).toBe(false);
    expect(isMcpOperationExchange(req("notifications/initialized"))).toBe(false);
  });

  it("is no body, a non-string body or one that is not JSON", () => {
    expect(isMcpOperationExchange(undefined)).toBe(false);
    expect(isMcpOperationExchange(new Uint8Array([123, 125]))).toBe(false);
    expect(isMcpOperationExchange("tools/call")).toBe(false);
    expect(isMcpOperationExchange("null")).toBe(false);
  });
});
