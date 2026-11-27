// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { targetsMcpEndpoint } from "../src/mcp-endpoint.ts";

const endpoint = { url: "https://mcp.example.com/v1/mcp", transport: "streamable-http" };

describe("targetsMcpEndpoint", () => {
  it("normalises the target path", () => {
    const cases: [string, boolean][] = [
      ["https://mcp.example.com/v1/mcp", true],
      ["https://mcp.example.com/v1/mcp/?x=1#f", true],
      ["https://mcp.example.com/v1/mcp/sse", true],
      ["https://mcp.example.com/v1/mcpx", false],
      ["https://mcp.example.com/v1", false],
      ["http://mcp.example.com/v1/mcp", false],
      ["https://mcp.example.com:8443/v1/mcp", false],
      ["https://other.example.com/v1/mcp", false],
      ["https://MCP.Example.COM/v1/mcp", true],
      ["https://mcp.example.com./v1/mcp", true],
      ["https://mcp.example.com:443/v1/mcp", true],
      ["https://mcp.example.com/v1/mcp/", true],
      ["https://mcp.example.com/v1/mcp?token=x", true],
      ["https://mcp.example.com/V1/MCP", true],
      ["https://mcp.example.com//v1///mcp", true],
      ["https://mcp.example.com/v1/%6Dcp", true],
      ["https://mcp.example.com/v1/%6dcp/x", true],
      // A malformed escape does not undo the valid ones around it.
      ["https://mcp.example.com/v1/%6Dcp/%zz", true],
      ["https://mcp.example.com/%76%31/mcp", true],
      ["https://mcp.example.com/v1/mcp;x=1", true],
      ["https://mcp.example.com/v1;a=b/mcp;c", true],
      ["https://mcp.example.com/v1/mcp;x/sub", true],
      ["https://mcp.example.com/v1/mcp%3Bx", true],
      ["https://mcp.example.com/v1/mcp-other", false],
      ["https://mcp.example.com/v1/mcpx;y", false],
      // Dot segments and backslashes a decoding proxy resolves before routing.
      ["https://mcp.example.com/other/..%2Fv1/mcp", true],
      ["https://mcp.example.com/..%2F..%2Fv1/mcp", true],
      ["https://mcp.example.com/other/%2e%2e/v1/mcp", true],
      ["https://mcp.example.com/other%5C..%5Cv1/mcp", true],
      ["https://mcp.example.com/v1/x/%2e%2e/mcp", true],
      ["https://mcp.example.com/v1/%2e/mcp", true],
      ["https://mcp.example.com/v1/mcp/x/..%2fother", true],
      ["https://mcp.example.com/v1%5Cmcp", true],
      ["https://mcp.example.com/v1/mcp/..%2Fother", false],
      ["https://mcp.example.com:444/v1/mcp", false],
      ["not a url", false],
    ];
    for (const [target, hit] of cases) {
      expect({ target, hit: targetsMcpEndpoint(target, endpoint) }).toEqual({ target, hit });
    }
  });

  it("keeps a malformed escape in the declared endpoint's path as written", () => {
    const odd = { url: "https://mcp.example.com/mcp/%zz" };
    expect(targetsMcpEndpoint("https://mcp.example.com/mcp/%zz", odd)).toBe(true);
    expect(targetsMcpEndpoint("https://mcp.example.com/mcp/%zz/x", odd)).toBe(true);
    expect(targetsMcpEndpoint("https://mcp.example.com/mcp", odd)).toBe(false);
    expect(
      targetsMcpEndpoint("https://mcp.example.com/mcp/%zz", { url: "https://mcp.example.com/mcp" }),
    ).toBe(true);
  });

  it("applies the same normalisation to the declared endpoint", () => {
    expect(
      targetsMcpEndpoint("https://mcp.example.com/v1/mcp", {
        url: "https://MCP.example.com:443/v1/mcp;p/?a=1",
      }),
    ).toBe(true);
    expect(
      targetsMcpEndpoint("https://mcp.example.com/MCP", { url: "https://mcp.example.com/mcp" }),
    ).toBe(true);
  });

  it("matches only the root path for an endpoint at the origin root", () => {
    const root = { url: "https://mcp.example.com/" };
    expect(targetsMcpEndpoint("https://mcp.example.com", root)).toBe(true);
    expect(targetsMcpEndpoint("https://mcp.example.com/?a=b", root)).toBe(true);
    expect(targetsMcpEndpoint("https://mcp.example.com/;x", root)).toBe(true);
    expect(targetsMcpEndpoint("https://mcp.example.com/v1/items", root)).toBe(false);
  });

  it("matches every path of the origin for an SSE endpoint, and that origin only", () => {
    const sse = { url: "https://mcp.example.com/v1/sse", transport: "sse" };
    expect(targetsMcpEndpoint("https://mcp.example.com/messages?sessionId=1", sse)).toBe(true);
    expect(targetsMcpEndpoint("https://mcp.example.com/", sse)).toBe(true);
    expect(targetsMcpEndpoint("https://other.example.com/messages", sse)).toBe(false);
    expect(targetsMcpEndpoint("http://mcp.example.com/messages", sse)).toBe(false);
  });
});
