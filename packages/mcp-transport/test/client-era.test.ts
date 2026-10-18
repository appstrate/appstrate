// SPDX-License-Identifier: Apache-2.0

/**
 * `createMcpHttpClient` speaks both protocol eras (#2082): MCP 2026-07-28 (stateless,
 * `server/discover`, version and identity in each request's `_meta`) and the 2025 `initialize`
 * handshake, choosing per the spec's backward-compatibility rules and remembering a legacy
 * verdict per origin. Each test uses its own origin: the verdict cache is process-wide.
 */

import { describe, it, expect } from "bun:test";
import { createMcpHttpClient, type AppstrateToolDefinition } from "../src/index.ts";
import {
  handlerFetch,
  legacyMcpHandler,
  modernMcpHandler,
  MODERN_PROTOCOL_VERSION,
  type McpHandler,
} from "../src/testing.ts";

const echo: AppstrateToolDefinition = {
  descriptor: {
    name: "echo",
    description: "Echoes its input.",
    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
  },
  handler: async (args) => ({ content: [{ type: "text", text: String(args.msg ?? "") }] }),
};

const tools = (n: number): AppstrateToolDefinition[] =>
  Array.from({ length: n }, (_, i) => ({
    descriptor: { name: `t${i}`, inputSchema: { type: "object" as const } },
    handler: async () => ({ content: [] }),
  }));

interface Seen {
  method: string | undefined;
  header: string | null;
  meta: unknown;
  status: number;
}

/** A handler behind a recorder of each request's JSON-RPC method, version header and `_meta`. */
function recorded(handler: McpHandler): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const inner = handlerFetch(handler);
  const fetcher = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const text = request.method === "POST" ? await request.clone().text() : "";
    const body = text
      ? (JSON.parse(text) as { method?: string; params?: { _meta?: unknown } })
      : {};
    const res = await inner(request);
    seen.push({
      method: body.method,
      header: request.headers.get("mcp-protocol-version"),
      meta: body.params?._meta,
      status: res.status,
    });
    return res;
  }) as typeof fetch;
  return { fetch: fetcher, seen };
}

let originSeq = 0;
const freshUrl = () => new URL(`http://era-${++originSeq}.test.invalid/mcp`);
const methods = (seen: Seen[]) => seen.map((s) => s.method);

describe("createMcpHttpClient — protocol eras", () => {
  it("legacy server: the probe is refused, the client falls back to initialize", async () => {
    const { fetch, seen } = recorded(legacyMcpHandler({ tools: [echo] }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("legacy");
      const res = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
      expect(res.content).toEqual([{ type: "text", text: "hi" }]);
      expect(methods(seen).slice(0, 2)).toEqual(["server/discover", "initialize"]);
      expect(seen[0]!.status).toBe(400);
    } finally {
      await client.close();
    }
  });

  it("modern-only server: no initialize, _meta and version header on every request", async () => {
    const { fetch, seen } = recorded(
      modernMcpHandler({
        tools: [echo],
        serverInfo: {
          name: "acme",
          version: "2.0.0",
          title: "Acme",
          websiteUrl: "https://acme.example",
        },
        instructions: "Use echo.",
      }),
    );
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect(client.getProtocol()).toEqual({ era: "modern", version: MODERN_PROTOCOL_VERSION });
      expect(client.getServerVersion()).toMatchObject({
        title: "Acme",
        websiteUrl: "https://acme.example",
      });
      expect(client.getInstructions()).toBe("Use echo.");
      const { tools: listed } = await client.listTools();
      expect(listed.map((t) => t.name)).toEqual(["echo"]);
      const res = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
      expect(res.content).toEqual([{ type: "text", text: "hi" }]);
      expect(methods(seen)).toEqual(["server/discover", "tools/list", "tools/call"]);
      for (const s of seen) {
        expect(s.header).toBe(MODERN_PROTOCOL_VERSION);
        expect(s.meta).toMatchObject({
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
        });
      }
    } finally {
      await client.close();
    }
  });

  it("dual-era server: the client stays modern", async () => {
    const { fetch, seen } = recorded(
      modernMcpHandler({ tools: [echo], legacy: legacyMcpHandler({ tools: [echo] }) }),
    );
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("modern");
      await client.callTool({ name: "echo", arguments: { msg: "x" } });
      expect(methods(seen)).not.toContain("initialize");
    } finally {
      await client.close();
    }
  });

  it("UnsupportedProtocolVersion listing a shared version: retried, never initialize", async () => {
    const { fetch, seen } = recorded(modernMcpHandler({ tools: [echo], refuseFirst: 1 }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("modern");
      expect(methods(seen)).toEqual(["server/discover", "server/discover"]);
      expect(seen[0]!.status).toBe(400);
    } finally {
      await client.close();
    }
  });

  it("pages tools/list one page at a time on a modern server", async () => {
    const { fetch } = recorded(modernMcpHandler({ tools: tools(5), pageSize: 2 }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      const first = await client.listToolsPage();
      expect(first.tools.map((t) => t.name)).toEqual(["t0", "t1"]);
      const second = await client.listToolsPage({ cursor: first.nextCursor! });
      expect(second.tools.map((t) => t.name)).toEqual(["t2", "t3"]);
      const all = await client.listTools();
      expect(all.tools).toHaveLength(5);
    } finally {
      await client.close();
    }
  });

  it("remembers a legacy origin: the next connect skips the probe", async () => {
    const url = freshUrl();
    const { fetch, seen } = recorded(legacyMcpHandler({ tools: [echo] }));
    await (await createMcpHttpClient(url, { fetch })).close();
    seen.length = 0;
    const again = await createMcpHttpClient(url, { fetch });
    try {
      expect(methods(seen)[0]).toBe("initialize");
      expect(methods(seen)).not.toContain("server/discover");
    } finally {
      await again.close();
    }
  });

  it("re-probes an origin remembered legacy once it refuses initialize", async () => {
    const url = freshUrl();
    let handler: McpHandler = legacyMcpHandler({ tools: [echo] });
    const { fetch, seen } = recorded((request) => handler(request));
    await (await createMcpHttpClient(url, { fetch })).close();
    // The server upgraded to the modern era only.
    handler = modernMcpHandler({ tools: [echo] });
    seen.length = 0;
    const client = await createMcpHttpClient(url, { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("modern");
      expect(methods(seen)).toEqual(["initialize", "server/discover"]);
    } finally {
      await client.close();
    }
  });

  it("a 401 on the probe is fatal, even with retry", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response("no", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    }) as unknown as typeof globalThis.fetch;
    const caught = await createMcpHttpClient(freshUrl(), {
      fetch,
      retry: { deadlineMs: 5_000, baseMs: 1, capMs: 2 },
    }).catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(Error);
    expect(calls).toBe(1);
  });

  it("retries a probe that hits a refused connection", async () => {
    let calls = 0;
    const working = handlerFetch(modernMcpHandler({ tools: [echo] }));
    const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        const err = new TypeError("Unable to connect");
        (err as { cause?: unknown }).cause = { code: "ConnectionRefused" };
        throw err;
      }
      return working(input as Request, init);
    }) as typeof globalThis.fetch;
    const client = await createMcpHttpClient(freshUrl(), {
      fetch,
      retry: { deadlineMs: 5_000, baseMs: 1, capMs: 2 },
    });
    try {
      expect(client.getProtocol()?.era).toBe("modern");
    } finally {
      await client.close();
    }
  });
});
