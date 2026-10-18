// SPDX-License-Identifier: Apache-2.0

/**
 * `createMcpHttpClient` speaks both protocol eras (#2082): MCP 2026-07-28 (stateless,
 * `server/discover`, version and identity in each request's `_meta`) and the 2025 `initialize`
 * handshake, choosing per the spec's backward-compatibility rules and remembering a legacy
 * verdict per origin. Each test uses its own origin: the verdict cache is process-wide.
 */

import { describe, it, expect } from "bun:test";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { createMcpHttpClient, httpStatusOf, type AppstrateToolDefinition } from "../src/index.ts";
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

/** A handler answering `server/discover` with `answer`, everything else with `rest`. */
const probeAnswered =
  (answer: (request: Request) => Promise<Response>, rest: McpHandler): McpHandler =>
  async (request) => {
    const text = request.method === "POST" ? await request.clone().text() : "";
    return text.includes('"server/discover"') ? answer(request) : rest(request);
  };
/** Never answers: waits for the request's own signal. */
const silent = (request: Request) =>
  new Promise<Response>((_, reject) => {
    request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
  });

describe("createMcpHttpClient — inconclusive probes and the era cache", () => {
  it("falls back to initialize when the probe is answered 5xx", async () => {
    const { fetch, seen } = recorded(
      probeAnswered(
        async () => new Response("oops", { status: 503 }),
        legacyMcpHandler({ tools: [echo] }),
      ),
    );
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("legacy");
      expect(methods(seen).slice(0, 2)).toEqual(["server/discover", "initialize"]);
    } finally {
      await client.close();
    }
  });

  it("surfaces the handshake's error when initialize fails after a 5xx probe", async () => {
    const { fetch, seen } = recorded(async () => new Response("down", { status: 502 }));
    const caught = await createMcpHttpClient(freshUrl(), { fetch }).catch((err: unknown) => err);
    expect(httpStatusOf(caught)).toBe(502);
    expect(methods(seen)).toEqual(["server/discover", "initialize"]);
  });

  it("falls back to initialize when the probe goes unanswered past its bound", async () => {
    const { fetch, seen } = recorded(probeAnswered(silent, legacyMcpHandler({ tools: [echo] })));
    const started = Date.now();
    const client = await createMcpHttpClient(freshUrl(), { fetch, defaultTimeoutMs: 150 });
    try {
      expect(client.getProtocol()?.era).toBe("legacy");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(methods(seen)).toContain("initialize");
    } finally {
      await client.close();
    }
  });

  it("re-probes a remembered legacy origin after a failure that is not a 4xx", async () => {
    const url = freshUrl();
    let handler: McpHandler = legacyMcpHandler({ tools: [echo] });
    const { fetch, seen } = recorded((request) => handler(request));
    await (await createMcpHttpClient(url, { fetch })).close();
    // Upgraded to the modern era, and its old `initialize` route now fails with a 5xx.
    const modern = modernMcpHandler({ tools: [echo] });
    handler = probeAnswered(modern, async (request) =>
      (await request.clone().text()).includes('"initialize"')
        ? new Response("gone", { status: 500 })
        : modern(request),
    );
    seen.length = 0;
    const client = await createMcpHttpClient(url, { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("modern");
      expect(methods(seen)).toEqual(["initialize", "server/discover"]);
    } finally {
      await client.close();
    }
  });

  it("era: legacy connects with initialize, no probe", async () => {
    const { fetch, seen } = recorded(legacyMcpHandler({ tools: [echo] }));
    const client = await createMcpHttpClient(freshUrl(), { fetch, era: "legacy" });
    try {
      expect(methods(seen)[0]).toBe("initialize");
      expect(methods(seen)).not.toContain("server/discover");
    } finally {
      await client.close();
    }
  });
});

describe("createMcpHttpClient — legacy server shapes", () => {
  it("echoes a stateful server's Mcp-Session-Id on every request after initialize", async () => {
    const sessions: (string | null)[] = [];
    const inner = handlerFetch(legacyMcpHandler({ tools: [echo], stateful: true }));
    const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if (request.method === "POST") sessions.push(request.headers.get("mcp-session-id"));
      return inner(request);
    }) as typeof globalThis.fetch;
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      const res = await client.callTool({ name: "echo", arguments: { msg: "s" } });
      expect(res.content).toEqual([{ type: "text", text: "s" }]);
      // The probe and `initialize` carry none; every request after them carries the server's.
      const after = sessions.slice(2);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((id) => typeof id === "string" && id === after[0])).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("reads a legacy server answering over SSE", async () => {
    const { fetch } = recorded(legacyMcpHandler({ tools: [echo], sse: true }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      const res = await client.callTool({ name: "echo", arguments: { msg: "sse" } });
      expect(res.content).toEqual([{ type: "text", text: "sse" }]);
    } finally {
      await client.close();
    }
  });
});

describe("createMcpHttpClient — tools/list", () => {
  it("lists every page from a server advertising no tools capability", async () => {
    const { fetch } = recorded(
      modernMcpHandler({ tools: tools(5), pageSize: 2, noToolsCapability: true }),
    );
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect((await client.listTools()).tools).toHaveLength(5);
      const second = await client.listToolsPage({ cursor: "2" });
      expect(second.tools.map((t) => t.name)).toEqual(["t2", "t3"]);
    } finally {
      await client.close();
    }
  });

  it("refuses a page without tools as the SDK's typed invalid result, not a TypeError", async () => {
    const modern = modernMcpHandler({ tools: [echo] });
    const fetch = handlerFetch(async (request) => {
      const text = await request.clone().text();
      if (!text.includes('"tools/list"')) return modern(request);
      const { id } = JSON.parse(text) as { id: number };
      const empty = !text.includes('"cursor"');
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: empty
          ? { resultType: "complete", nextCursor: "1" }
          : { resultType: "complete", tools: [echo.descriptor] },
      });
    });
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      const caught = await client.listToolsPage().catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(SdkError);
      expect((caught as SdkError).code).toBe(SdkErrorCode.InvalidResult);
    } finally {
      await client.close();
    }
  });

  it("excludes a tool with an invalid x-mcp-header on a modern connection, and says so", async () => {
    const bad: AppstrateToolDefinition = {
      descriptor: {
        name: "bad",
        inputSchema: {
          type: "object",
          properties: { region: { type: "string", "x-mcp-header": "Bad Header" } },
        },
      },
      handler: async () => ({ content: [] }),
    };
    const warnings: string[] = [];
    const modern = recorded(modernMcpHandler({ tools: [echo, bad] }));
    const client = await createMcpHttpClient(freshUrl(), {
      fetch: modern.fetch,
      onWarning: (message) => warnings.push(message),
    });
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("bad");
    } finally {
      await client.close();
    }
    // A legacy connection carries no per-request headers: the rule does not bind there.
    const legacy = recorded(legacyMcpHandler({ tools: [echo, bad] }));
    const old = await createMcpHttpClient(freshUrl(), { fetch: legacy.fetch });
    try {
      expect((await old.listTools()).tools.map((t) => t.name)).toEqual(["echo", "bad"]);
    } finally {
      await old.close();
    }
  });

  it("mirrors a valid x-mcp-header parameter into its header on tools/call", async () => {
    const regional: AppstrateToolDefinition = {
      descriptor: {
        name: "regional",
        inputSchema: {
          type: "object",
          properties: { region: { type: "string", "x-mcp-header": "Region" } },
        },
      },
      handler: async () => ({ content: [] }),
    };
    let header: string | null = null;
    const inner = handlerFetch(modernMcpHandler({ tools: [regional] }));
    const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      if ((await request.clone().text()).includes('"tools/call"')) {
        header = request.headers.get("mcp-param-region");
      }
      return inner(request);
    }) as typeof globalThis.fetch;
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      await client.callTool({ name: "regional", arguments: { region: "eu-west1" } });
      expect(header as string | null).toBe("eu-west1");
    } finally {
      await client.close();
    }
  });

  it("refuses calls once a modern client is closed", async () => {
    const { fetch } = recorded(modernMcpHandler({ tools: [echo] }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    await client.close();
    await client.close();
    await expect(client.listTools()).rejects.toThrow(/closed/);
    await expect(client.callTool({ name: "echo" })).rejects.toThrow(/closed/);
  });
});
