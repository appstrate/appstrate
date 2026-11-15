// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { mcpFetch } from "../src/index.ts";

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
    expect(fetchLike.preconnect).toBe(fetch.preconnect);
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
