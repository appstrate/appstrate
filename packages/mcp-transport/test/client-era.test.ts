// SPDX-License-Identifier: Apache-2.0

/**
 * `createMcpHttpClient` speaks both protocol eras (#2082): MCP 2026-07-28 (stateless,
 * `server/discover`, version and identity in each request's `_meta`) and the 2025 `initialize`
 * handshake, choosing per the spec's backward-compatibility rules and remembering a legacy
 * verdict per origin. Each test uses its own origin: the verdict cache is process-wide.
 */

import { describe, it, expect } from "bun:test";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { setCacheClock } from "@appstrate/core/cache";
import {
  createMcpHttpClient,
  createMcpServer,
  httpStatusOf,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateToolDefinition,
  type Tool,
} from "../src/index.ts";
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

  for (const status of [500, 429, 408]) {
    it(`keeps a remembered legacy verdict through a ${status}, surfacing it without a probe`, async () => {
      const url = freshUrl();
      let handler: McpHandler = legacyMcpHandler({ tools: [echo] });
      const { fetch, seen } = recorded((request) => handler(request));
      await (await createMcpHttpClient(url, { fetch })).close();
      const legacy = handler;
      handler = async () => new Response("busy", { status });
      seen.length = 0;
      const caught = await createMcpHttpClient(url, { fetch }).catch((err: unknown) => err);
      expect(httpStatusOf(caught)).toBe(status);
      expect(methods(seen)).toEqual(["initialize"]);
      // The verdict survived: once back, the origin still skips the probe.
      handler = legacy;
      seen.length = 0;
      await (await createMcpHttpClient(url, { fetch })).close();
      expect(methods(seen)[0]).toBe("initialize");
      expect(methods(seen)).not.toContain("server/discover");
    });
  }

  for (const [what, fault] of [
    ["refuses connections", "ConnectionRefused"],
    ["times out", "ETIMEDOUT"],
  ] as const) {
    it(`makes one attempt at a remembered legacy origin that ${what}`, async () => {
      const url = freshUrl();
      let down = false;
      let attempts = 0;
      const inner = handlerFetch(legacyMcpHandler({ tools: [echo] }));
      const fetch = (async (input: Request | string | URL, init?: RequestInit) => {
        if (!down) return inner(input as Request, init);
        attempts += 1;
        const err = new TypeError("fetch failed");
        (err as { cause?: unknown }).cause = { code: fault };
        throw err;
      }) as typeof globalThis.fetch;
      await (await createMcpHttpClient(url, { fetch })).close();
      down = true;
      await expect(createMcpHttpClient(url, { fetch })).rejects.toThrow("fetch failed");
      expect(attempts).toBe(1);
    });
  }

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

describe("createMcpHttpClient — convergence of the era fallback", () => {
  /** Answers `server/discover` 503 the first `n` times, then as `handler`. */
  const flakyProbe = (n: number, handler: McpHandler): McpHandler => {
    let left = n;
    return probeAnswered(async (request) => {
      if (left > 0) {
        left -= 1;
        return new Response("busy", { status: 503 });
      }
      return handler(request);
    }, handler);
  };

  it("keeps a modern-only server's transient probe 5xx as the error, not initialize's 400", async () => {
    const { fetch, seen } = recorded(flakyProbe(1, modernMcpHandler({ tools: [echo] })));
    const caught = await createMcpHttpClient(freshUrl(), { fetch }).catch((err: unknown) => err);
    expect(httpStatusOf(caught)).toBe(503);
    expect(methods(seen)).toEqual(["server/discover", "initialize"]);
  });

  it("lets the retry loop ride a modern server's transient probe 5xx", async () => {
    const { fetch } = recorded(flakyProbe(1, modernMcpHandler({ tools: [echo] })));
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

  it("re-probes from the cached path through the same fallback (no internal error leaks)", async () => {
    const url = freshUrl();
    let handler: McpHandler = legacyMcpHandler({ tools: [echo] });
    const { fetch } = recorded((request) => handler(request));
    await (await createMcpHttpClient(url, { fetch })).close();
    handler = flakyProbe(1, modernMcpHandler({ tools: [echo] }));
    const caught = await createMcpHttpClient(url, { fetch }).catch((err: unknown) => err);
    expect((caught as Error).constructor.name).not.toBe("ProbeInconclusive");
    expect(httpStatusOf(caught)).toBe(503);
  });

  it("remembers a fallback's legacy as a probe's (15 min), then probes again", async () => {
    let now = Date.now();
    setCacheClock(() => now);
    try {
      const url = freshUrl();
      const { fetch, seen } = recorded(
        flakyProbe(
          1,
          modernMcpHandler({ tools: [echo], legacy: legacyMcpHandler({ tools: [echo] }) }),
        ),
      );
      const first = await createMcpHttpClient(url, { fetch });
      expect(first.getProtocol()?.era).toBe("legacy");
      await first.close();
      // Within the verdict: no probe.
      now += 14 * 60_000;
      seen.length = 0;
      await (await createMcpHttpClient(url, { fetch })).close();
      expect(methods(seen)).not.toContain("server/discover");
      // Past it: the dual-era server is probed, and answers modern.
      now += 60_000 + 1;
      seen.length = 0;
      const later = await createMcpHttpClient(url, { fetch });
      try {
        expect(methods(seen)[0]).toBe("server/discover");
        expect(later.getProtocol()?.era).toBe("modern");
      } finally {
        await later.close();
      }
    } finally {
      setCacheClock(null);
    }
  });

  it("does not re-probe on every connect a legacy server that 5xxs the probe", async () => {
    const url = freshUrl();
    const { fetch, seen } = recorded(
      probeAnswered(
        async () => new Response("no", { status: 500 }),
        legacyMcpHandler({ tools: [echo] }),
      ),
    );
    await (await createMcpHttpClient(url, { fetch })).close();
    seen.length = 0;
    await (await createMcpHttpClient(url, { fetch })).close();
    expect(methods(seen)[0]).toBe("initialize");
    expect(methods(seen)).not.toContain("server/discover");
  });

  it("does not renew a legacy verdict on each cached connect: it expires from the probe", async () => {
    let now = Date.now();
    setCacheClock(() => now);
    try {
      const url = freshUrl();
      const { fetch, seen } = recorded(legacyMcpHandler({ tools: [echo] }));
      await (await createMcpHttpClient(url, { fetch })).close();
      now += 10 * 60_000;
      await (await createMcpHttpClient(url, { fetch })).close();
      now += 10 * 60_000;
      seen.length = 0;
      await (await createMcpHttpClient(url, { fetch })).close();
      expect(methods(seen)[0]).toBe("server/discover");
    } finally {
      setCacheClock(null);
    }
  });

  it("an abort during a hanging probe returns promptly", async () => {
    const { fetch } = recorded(probeAnswered(silent, legacyMcpHandler({ tools: [echo] })));
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("caller gave up")), 50);
    const started = Date.now();
    const caught = await createMcpHttpClient(freshUrl(), { fetch, signal: ac.signal }).catch(
      (err: unknown) => err,
    );
    expect((caught as Error).message).toBe("caller gave up");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refreshes the tool list and retries once on a HeaderMismatch", async () => {
    const plain: AppstrateToolDefinition = {
      descriptor: {
        name: "regional",
        inputSchema: { type: "object", properties: { region: { type: "string" } } },
      },
      handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
    };
    const annotated: AppstrateToolDefinition = {
      ...plain,
      descriptor: {
        name: "regional",
        inputSchema: {
          type: "object",
          properties: { region: { type: "string", "x-mcp-header": "Region" } },
        },
      },
    };
    let handler = modernMcpHandler({ tools: [plain] });
    const { fetch, seen } = recorded((request) => handler(request));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      // The server now mirrors `region` into a header the client's stale definition omits.
      handler = modernMcpHandler({ tools: [annotated] });
      seen.length = 0;
      const res = await client.callTool({ name: "regional", arguments: { region: "eu" } });
      expect(res.content).toEqual([{ type: "text", text: "ok" }]);
      expect(methods(seen)).toEqual(["tools/call", "tools/list", "tools/call"]);
      expect(seen[0]!.status).toBe(400);
    } finally {
      await client.close();
    }
  });
});

describe("createMcpHttpClient — tools/call retries", () => {
  /** Counts `tools/call` POSTs, answering each as `answer` (the rest as `handler`). */
  const countingCalls = (handler: McpHandler, answer?: (request: Request) => Promise<Response>) => {
    let calls = 0;
    const fetch = handlerFetch(async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (text.includes('"tools/call"')) {
        calls += 1;
        if (answer) return answer(request);
      }
      return handler(request);
    });
    return { fetch, calls: () => calls };
  };
  const mismatch = async (request: Request) => {
    const { id } = (await request.clone().json()) as { id: number };
    return Response.json(
      { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch" } },
      { status: 400 },
    );
  };

  it("never resends a tools/call a legacy server answered -32020", async () => {
    const { fetch, calls } = countingCalls(legacyMcpHandler({ tools: [echo] }), async (request) => {
      const { id } = (await request.clone().json()) as { id: number };
      return Response.json({ jsonrpc: "2.0", id, error: { code: -32020, message: "app error" } });
    });
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      await expect(client.callTool({ name: "echo", arguments: { msg: "x" } })).rejects.toThrow();
      expect(calls()).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("sends a modern tools/call at most twice on a persistent HeaderMismatch", async () => {
    const { fetch, calls } = countingCalls(modernMcpHandler({ tools: [echo] }), mismatch);
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      // Never listed: the SDK's own recovery refetches the list and resends once.
      await expect(client.callTool({ name: "echo", arguments: { msg: "x" } })).rejects.toThrow();
      expect(calls()).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("drops a definition a refreshed listing no longer carries", async () => {
    const other: AppstrateToolDefinition = {
      descriptor: { name: "other", inputSchema: { type: "object" } },
      handler: async () => ({ content: [] }),
    };
    let handler = modernMcpHandler({ tools: [echo, other] });
    const fetch = handlerFetch((request) => handler(request));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect((await client.listTools()).tools).toHaveLength(2);
      handler = modernMcpHandler({ tools: [echo] });
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["echo"]);
      // `other` is gone from the session: a call to it carries no stale definition, so the
      // server's own refusal comes back rather than a mirrored-header retry.
      await expect(client.callTool({ name: "other" })).rejects.toThrow(/Unknown tool/);
    } finally {
      await client.close();
    }
  });

  it("bounds the refresh listing by the call's own timeout", async () => {
    let listing = false;
    const modern = modernMcpHandler({ tools: [echo] });
    const fetch = handlerFetch(async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (text.includes('"tools/list"') && listing) return silent(request);
      if (text.includes('"tools/call"')) {
        listing = true;
        return mismatch(request);
      }
      return modern(request);
    });
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      const started = Date.now();
      await expect(client.callTool({ name: "echo" }, { timeoutMs: 150 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await client.close();
    }
  });
});

describe("createMcpHttpClient — the session's tool definitions", () => {
  const regional: AppstrateToolDefinition = {
    descriptor: {
      name: "regional",
      inputSchema: {
        type: "object",
        properties: { region: { type: "string", "x-mcp-header": "Region" } },
      },
    },
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  };

  /** Counts `tools/list` and `tools/call`, records each call's mirrored header. */
  function observed(handler: () => McpHandler) {
    const counts = { list: 0, call: 0 };
    const headers: (string | null)[] = [];
    const fetch = handlerFetch(async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (text.includes('"tools/list"')) counts.list += 1;
      if (text.includes('"tools/call"')) {
        counts.call += 1;
        headers.push(request.headers.get("mcp-param-region"));
      }
      return handler()(request);
    });
    return { fetch, counts, headers };
  }

  it("keeps the previous definitions when a refresh fails", async () => {
    let failList = false;
    let mismatchOnce = false;
    const modern = modernMcpHandler({ tools: [regional] });
    const handler: McpHandler = async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (text.includes('"tools/list"') && failList) return new Response("down", { status: 500 });
      if (text.includes('"tools/call"') && mismatchOnce) {
        mismatchOnce = false;
        const { id } = JSON.parse(text) as { id: number };
        return Response.json(
          { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch" } },
          { status: 400 },
        );
      }
      return modern(request);
    };
    const { fetch, headers } = observed(() => handler);
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      failList = true;
      mismatchOnce = true;
      await expect(
        client.callTool({ name: "regional", arguments: { region: "x" } }),
      ).rejects.toThrow();
      // The failed refresh left the listing in place: the next call still mirrors its header.
      await client.callTool({ name: "regional", arguments: { region: "y" } });
      expect(headers.at(-1)).toBe("y");
    } finally {
      await client.close();
    }
  });

  it("does not resend when the refreshed listing no longer has the tool", async () => {
    let gone = false;
    const withTool = modernMcpHandler({ tools: [regional] });
    const without = modernMcpHandler({ tools: [] });
    const handler: McpHandler = async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (text.includes('"tools/call"')) {
        gone = true;
        const { id } = JSON.parse(text) as { id: number };
        return Response.json(
          { jsonrpc: "2.0", id, error: { code: -32020, message: "Header mismatch" } },
          { status: 400 },
        );
      }
      return (gone ? without : withTool)(request);
    };
    const { fetch, counts } = observed(() => handler);
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      const caught = await client
        .callTool({ name: "regional", arguments: { region: "x" } })
        .catch((err: unknown) => err);
      expect((caught as { code?: unknown }).code).toBe(-32020);
      expect(counts.call).toBe(1);
    } finally {
      await client.close();
    }
  });
});

describe("tool outputs are validated against the listed outputSchema", () => {
  const typed: AppstrateToolDefinition = {
    descriptor: {
      name: "typed",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
    },
    handler: async () => ({ content: [] }),
  };
  const outsideSchema = /does not match the tool's output schema/;

  /** A legacy server whose `tools/call` answers `structured()`, unchecked by the server. */
  function legacyAnswering(structured: () => unknown) {
    const legacy = legacyMcpHandler({ tools: [typed] });
    let lists = 0;
    let calls = 0;
    const fetch = handlerFetch(async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      if (text.includes('"tools/list"')) lists += 1;
      if (!text.includes('"tools/call"')) return legacy(request);
      calls += 1;
      const { id } = JSON.parse(text) as { id: number };
      const result = { content: [], structuredContent: structured() };
      return Response.json({ jsonrpc: "2.0", id, result });
    });
    return { fetch, lists: () => lists, calls: () => calls };
  }

  it("legacy connection: a conforming output passes, a non-conforming one is refused", async () => {
    let answer: unknown = { ok: true };
    const { fetch } = legacyAnswering(() => answer);
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect(client.getProtocol()?.era).toBe("legacy");
      await client.listTools();
      const res = await client.callTool({ name: "typed" });
      expect(res.structuredContent).toEqual({ ok: true });
      answer = { ok: "wrong" };
      await expect(client.callTool({ name: "typed" })).rejects.toThrow(outsideSchema);
    } finally {
      await client.close();
    }
  });

  it("legacy connection: a call sends no tools/list of its own", async () => {
    const { fetch, lists, calls } = legacyAnswering(() => ({ ok: true }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.callTool({ name: "typed" });
      expect({ lists: lists(), calls: calls() }).toEqual({ lists: 0, calls: 1 });
    } finally {
      await client.close();
    }
  });

  it("modern connection: a non-conforming output is refused", async () => {
    let answer: unknown = { ok: true };
    const tool = { ...typed, handler: async () => ({ content: [], structuredContent: answer }) };
    const fetch = handlerFetch(modernMcpHandler({ tools: [tool as AppstrateToolDefinition] }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      await client.listTools();
      expect((await client.callTool({ name: "typed" })).structuredContent).toEqual({ ok: true });
      answer = { ok: "wrong" };
      await expect(client.callTool({ name: "typed" })).rejects.toThrow(outsideSchema);
    } finally {
      await client.close();
    }
  });
});

describe("tools/list pagination on every SDK line", () => {
  const paged = (n: number): AppstrateToolDefinition[] =>
    Array.from({ length: n }, (_, i) => ({
      descriptor: {
        name: `p${i}`,
        inputSchema: { type: "object" as const },
        outputSchema: { type: "object" as const, required: ["ok"] },
      },
      handler: async () => ({ content: [] }),
    }));

  /** A v1 in-process server one tool per page, whose calls answer an output outside the schema. */
  async function pagedPair(defs: AppstrateToolDefinition[]) {
    const server = createMcpServer(defs);
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      const start = Number(request.params?.cursor ?? 0);
      return {
        tools: defs.slice(start, start + 1).map((d) => d.descriptor),
        ...(start + 1 < defs.length ? { nextCursor: String(start + 1) } : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [],
      structuredContent: { nope: true },
    }));
    const client = new Client({ name: "paged-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return wrapClient(client, { close: () => server.close() });
  }

  it("wrapClient lists every page and validates the outputs of tools from each", async () => {
    const client = await pagedPair(paged(3));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["p0", "p1", "p2"]);
      for (const name of ["p0", "p2"]) {
        await expect(client.callTool({ name })).rejects.toThrow(
          /does not match the tool's output schema/,
        );
      }
    } finally {
      await client.close();
    }
  });

  /** A v1 in-process server whose every page holds one tool and names `next(cursor)`. */
  async function endlessPair(next: (cursor: string | undefined) => string) {
    const server = createMcpServer(paged(1));
    server.setRequestHandler(ListToolsRequestSchema, async (request) => ({
      tools: paged(1).map((d) => d.descriptor),
      nextCursor: next(request.params?.cursor),
    }));
    const client = new Client({ name: "endless-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return wrapClient(client, { close: () => server.close() });
  }

  it("refuses a server repeating its cursor, with no partial list", async () => {
    const client = await endlessPair(() => "same");
    try {
      await expect(client.listTools()).rejects.toThrow("tools/list repeated its cursor 'same'");
    } finally {
      await client.close();
    }
  });

  it("refuses a server still paginating past 64 pages, with no partial list", async () => {
    const client = await endlessPair((cursor) => String(Number(cursor ?? 0) + 1));
    try {
      await expect(client.listTools()).rejects.toThrow("tools/list did not end within 64 pages");
    } finally {
      await client.close();
    }
  });

  it("a legacy HTTP server's pages are all listed", async () => {
    const fetch = handlerFetch(legacyMcpHandler({ tools: tools(5), pageSize: 2 }));
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    try {
      expect((await client.listToolsPage()).nextCursor).toBe("2");
      expect((await client.listTools()).tools).toHaveLength(5);
    } finally {
      await client.close();
    }
  });
});

describe("a tools/list refresh installs its definitions only once complete", () => {
  const strict = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const outsideSchema = /does not match the tool's output schema/;

  /**
   * Two pages: `typed` (strict, permissive once `refreshing`), then `other`. Page 2 waits on
   * `page2()` and answers a server error when it says `fail`.
   */
  function catalogue() {
    const state = {
      refreshing: false,
      answer: { ok: true } as unknown,
      page2: async (): Promise<"ok" | "fail"> => "ok",
    };
    const page = async (cursor: unknown): Promise<{ tools: Tool[]; nextCursor?: string }> => {
      if (cursor === undefined) {
        const outputSchema = (
          state.refreshing ? { type: "object" } : strict
        ) as Tool["outputSchema"];
        return {
          tools: [{ name: "typed", inputSchema: { type: "object" }, outputSchema }],
          nextCursor: "1",
        };
      }
      if ((await state.page2()) === "fail") throw new Error("page 2 unavailable");
      return { tools: [{ name: "other", inputSchema: { type: "object" } }] };
    };
    return { state, page };
  }

  type State = ReturnType<typeof catalogue>["state"];

  async function overHttp(era: "modern" | "legacy") {
    const { state, page } = catalogue();
    const base =
      era === "modern" ? modernMcpHandler({ tools: [echo] }) : legacyMcpHandler({ tools: [echo] });
    const complete = era === "modern" ? { resultType: "complete" } : {};
    const cacheable = era === "modern" ? { ttlMs: 0, cacheScope: "public" } : {};
    const fetch = handlerFetch(async (request) => {
      const text = request.method === "POST" ? await request.clone().text() : "";
      const body = text
        ? (JSON.parse(text) as { id?: number; method?: string; params?: { cursor?: string } })
        : {};
      if (body.method === "tools/list") {
        try {
          const result = { ...complete, ...cacheable, ...(await page(body.params?.cursor)) };
          return Response.json({ jsonrpc: "2.0", id: body.id, result });
        } catch {
          return new Response("upstream down", { status: 500 });
        }
      }
      if (body.method === "tools/call") {
        const result = { ...complete, content: [], structuredContent: state.answer };
        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      }
      return base(request);
    });
    const client = await createMcpHttpClient(freshUrl(), { fetch });
    expect(client.getProtocol()?.era).toBe(era);
    return { client, state };
  }

  async function inProcess() {
    const { state, page } = catalogue();
    const server = createMcpServer([echo]);
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      page(request.params?.cursor),
    );
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [],
      structuredContent: state.answer as Record<string, unknown>,
    }));
    const legacy = new Client({ name: "refresh-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), legacy.connect(clientTransport)]);
    return { client: wrapClient(legacy, { close: () => server.close() }), state };
  }

  const lines: [string, () => Promise<{ client: AppstrateMcpClient; state: State }>][] = [
    ["modern HTTP", () => overHttp("modern")],
    ["legacy HTTP", () => overHttp("legacy")],
    ["wrapClient (v1)", inProcess],
  ];

  for (const [line, connect] of lines) {
    it(`${line}: a refresh failing on page 2 keeps the previous complete set`, async () => {
      const { client, state } = await connect();
      try {
        await client.listTools();
        state.refreshing = true;
        state.page2 = async () => "fail";
        await expect(client.listTools()).rejects.toThrow();
        state.answer = { ok: "wrong" };
        await expect(client.callTool({ name: "typed" })).rejects.toThrow(outsideSchema);
      } finally {
        await client.close();
      }
    });

    it(`${line}: a call made mid-refresh validates against the previous complete set`, async () => {
      const { client, state } = await connect();
      try {
        await client.listTools();
        state.refreshing = true;
        let reached!: () => void;
        let release!: () => void;
        const atPage2 = new Promise<void>((resolve) => (reached = resolve));
        const held = new Promise<void>((resolve) => (release = resolve));
        state.page2 = async () => {
          reached();
          await held;
          return "ok";
        };
        const refresh = client.listTools();
        await atPage2;
        state.answer = { ok: "wrong" };
        await expect(client.callTool({ name: "typed" })).rejects.toThrow(outsideSchema);
        release();
        expect((await refresh).tools.map((t) => t.name)).toEqual(["typed", "other"]);
        expect((await client.callTool({ name: "typed" })).structuredContent).toEqual({
          ok: "wrong",
        });
      } finally {
        await client.close();
      }
    });
  }
});
