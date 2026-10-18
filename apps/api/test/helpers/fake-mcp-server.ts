// SPDX-License-Identifier: Apache-2.0

/**
 * A remote MCP server on loopback (Streamable HTTP, stateless, JSON responses), for route tests
 * that reach one through the platform. Configurable tools (paginated by `pageSize`), `serverInfo`,
 * `instructions`, and a required bearer; records the `Authorization` header of every request.
 * Lifted from `mountStandalone` in `packages/mcp-transport/test/client.test.ts`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema, type Implementation } from "@modelcontextprotocol/sdk/types.js";

export interface FakeMcpServerOptions {
  tools?: string[];
  /** Tools per `tools/list` page; omitted = one page. */
  pageSize?: number;
  serverInfo?: Implementation;
  instructions?: string;
  /** The bearer the server accepts; any other `Authorization` answers 401. */
  bearer?: string;
}

export interface FakeMcpServer {
  /** The MCP endpoint, `http://127.0.0.1:<port>/mcp`. */
  url: string;
  origin: string;
  /** The `Authorization` header of every request received, in order. */
  authorizations: (string | null)[];
  /** The HTTP methods received, in order. */
  methods: string[];
  stop(): void;
}

export function startFakeMcpServer(opts: FakeMcpServerOptions = {}): FakeMcpServer {
  const tools = (opts.tools ?? []).map((name) => ({
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const, properties: {} },
  }));
  const pageSize = opts.pageSize ?? Math.max(tools.length, 1);
  const authorizations: (string | null)[] = [];
  const methods: string[] = [];

  const handle = async (request: Request): Promise<Response> => {
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

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      authorizations.push(req.headers.get("authorization"));
      methods.push(req.method);
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (opts.bearer && req.headers.get("authorization") !== `Bearer ${opts.bearer}`) {
        return new Response("unauthorized", { status: 401 });
      }
      return handle(req);
    },
  });
  const origin = `http://127.0.0.1:${http.port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    authorizations,
    methods,
    stop: () => http.stop(true),
  };
}
