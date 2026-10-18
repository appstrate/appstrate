// SPDX-License-Identifier: Apache-2.0

/**
 * A remote MCP server on loopback (Streamable HTTP, stateless, JSON responses), for route tests
 * that reach one through the platform. Configurable tools (paginated by `pageSize`), `serverInfo`,
 * `instructions`, a required bearer, and values a hostile server would have its client echo (a
 * session id, a cursor prefix); records every request. Its protocol era is `legacy` (the
 * `initialize` handshake, the default), `modern` (MCP 2026-07-28 only) or `dual`.
 * Lifted from `mountStandalone` in `packages/mcp-transport/test/client.test.ts`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  ListToolsRequestSchema,
  type Implementation,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { modernMcpHandler } from "@appstrate/mcp-transport/testing";

/** A name alone gets the description `Tool <name>` and no annotations. */
export type FakeMcpTool =
  string | { name: string; title?: string; description?: string; annotations?: ToolAnnotations };

export interface FakeMcpServerOptions {
  tools?: FakeMcpTool[];
  /** Tools per `tools/list` page; omitted = one page. */
  pageSize?: number;
  serverInfo?: Implementation;
  instructions?: string;
  /** The bearer the server accepts; any other `Authorization` answers 401. */
  bearer?: string;
  /** Answered as `Mcp-Session-Id` on every response: the client echoes it on each request. */
  sessionId?: string;
  /** The protocol era the server speaks; `legacy` when omitted. */
  era?: "legacy" | "modern" | "dual";
}

export interface FakeMcpServer {
  /** The MCP endpoint, `http://127.0.0.1:<port>/mcp`. */
  url: string;
  origin: string;
  /** The `Authorization` header of every request received, in order. */
  authorizations: (string | null)[];
  /** The HTTP methods received, in order. */
  methods: string[];
  /** Every request's headers and body text, in order. */
  requests: { headers: Headers; body: string }[];
  stop(): void;
}

export function startFakeMcpServer(opts: FakeMcpServerOptions = {}): FakeMcpServer {
  const tools = (opts.tools ?? []).map((tool) => ({
    ...(typeof tool === "string" ? { name: tool, description: `Tool ${tool}` } : tool),
    inputSchema: { type: "object" as const, properties: {} },
  }));
  const pageSize = opts.pageSize ?? Math.max(tools.length, 1);
  const authorizations: (string | null)[] = [];
  const methods: string[] = [];
  const requests: { headers: Headers; body: string }[] = [];

  const handleLegacy = async (request: Request): Promise<Response> => {
    const server = new Server(opts.serverInfo ?? { name: "fake-mcp", version: "1.0.0" }, {
      capabilities: { tools: {} },
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const start = Number(req.params?.cursor ?? 0);
      const end = start + pageSize;
      return {
        tools: tools.slice(start, end),
        ...(end < tools.length ? { nextCursor: String(end) } : {}),
      };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      await transport.close();
      await server.close();
    }
  };

  const era = opts.era ?? "legacy";
  const handle =
    era === "legacy"
      ? handleLegacy
      : modernMcpHandler({
          tools: tools.map((descriptor) => ({
            descriptor,
            handler: async () => ({ content: [] }),
          })),
          pageSize,
          ...(opts.serverInfo ? { serverInfo: opts.serverInfo } : {}),
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
          ...(era === "dual" ? { legacy: handleLegacy } : {}),
        });

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      authorizations.push(req.headers.get("authorization"));
      methods.push(req.method);
      requests.push({ headers: req.headers, body });
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (opts.bearer && req.headers.get("authorization") !== `Bearer ${opts.bearer}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const res = await handle(
        new Request(req.url, {
          method: req.method,
          headers: req.headers,
          ...(body ? { body } : {}),
        }),
      );
      if (opts.sessionId) res.headers.set("Mcp-Session-Id", opts.sessionId);
      return res;
    },
  });
  const origin = `http://127.0.0.1:${http.port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    authorizations,
    methods,
    requests,
    stop: () => http.stop(true),
  };
}
