// SPDX-License-Identifier: Apache-2.0

/**
 * A remote MCP server on loopback (Streamable HTTP, stateless, JSON responses), for route tests
 * that reach one through the platform. Configurable tools (paginated by `pageSize`), `serverInfo`,
 * `instructions`, a required bearer, and values a hostile server would have its client echo (a
 * session id, a cursor prefix), a delay (on every request or one method's), event-stream answers;
 * records every request. Its protocol era is `legacy` (the
 * `initialize` handshake, the default), `modern` (MCP 2026-07-28 only) or `dual`.
 * Served by the fake handlers of `@appstrate/mcp-transport/testing`.
 */

import type {
  CallToolResult,
  Implementation,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { legacyMcpHandler, modernMcpHandler } from "@appstrate/mcp-transport/testing";

/**
 * A name alone gets the description `Tool <name>` and no annotations. A call answers `result`,
 * else its arguments as JSON text.
 */
export type FakeMcpTool =
  | string
  | {
      name: string;
      title?: string;
      description?: string;
      annotations?: ToolAnnotations;
      outputSchema?: Tool["outputSchema"];
      result?: CallToolResult;
    };

/** A 1×1 transparent PNG as an MCP `image` content block. */
export const PNG_IMAGE_CONTENT = {
  type: "image" as const,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  mimeType: "image/png",
};

export interface FakeMcpServerOptions {
  tools?: FakeMcpTool[];
  /** Tools per `tools/list` page; omitted = one page. */
  pageSize?: number;
  serverInfo?: Implementation;
  instructions?: string;
  /** The bearer the server accepts; any other `Authorization` answers `rejectStatus`. */
  bearer?: string;
  /** What another `Authorization` than `bearer` answers; 401 when omitted. */
  rejectStatus?: 401 | 403;
  /** Answered as `Mcp-Session-Id` on every response: the client echoes it on each request. */
  sessionId?: string;
  /** The protocol era the server speaks; `legacy` when omitted. */
  era?: "legacy" | "modern" | "dual";
  /** Waits this long before answering each request, or only those of `delayedMethod`. */
  delayMs?: number;
  /** The JSON-RPC method `delayMs` applies to; every request when omitted. */
  delayedMethod?: string;
  /** Answers requests as `text/event-stream` (legacy era only). */
  sse?: boolean;
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
  /** Lists the tools in the reverse order from now on (stateless eras: the next request). */
  reverseTools(): void;
  stop(): void;
}

export function startFakeMcpServer(opts: FakeMcpServerOptions = {}): FakeMcpServer {
  const tools = (opts.tools ?? []).map((tool) => {
    const { result, ...descriptor } =
      typeof tool === "string" ? { name: tool, description: `Tool ${tool}` } : tool;
    return {
      descriptor: { ...descriptor, inputSchema: { type: "object" as const, properties: {} } },
      handler: async (args: unknown): Promise<CallToolResult> =>
        result ?? { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] },
    };
  });
  const served = {
    tools,
    ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
    ...(opts.serverInfo ? { serverInfo: opts.serverInfo } : {}),
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  };
  const authorizations: (string | null)[] = [];
  const methods: string[] = [];
  const requests: { headers: Headers; body: string }[] = [];

  const era = opts.era ?? "legacy";
  const legacy = legacyMcpHandler({ ...served, ...(opts.sse ? { sse: true } : {}) });
  const handle =
    era === "legacy"
      ? legacy
      : modernMcpHandler({ ...served, ...(era === "dual" ? { legacy } : {}) });

  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = await req.text();
      authorizations.push(req.headers.get("authorization"));
      methods.push(req.method);
      requests.push({ headers: req.headers, body });
      if (opts.delayMs && (!opts.delayedMethod || body.includes(`"${opts.delayedMethod}"`))) {
        await Bun.sleep(opts.delayMs);
      }
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      if (opts.bearer && req.headers.get("authorization") !== `Bearer ${opts.bearer}`) {
        return new Response("unauthorized", { status: opts.rejectStatus ?? 401 });
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
    reverseTools: () => void tools.reverse(),
    stop: () => http.stop(true),
  };
}

/**
 * A loopback relay to `upstream` (raw HTTP/1.1, one small request per connection) whose answer to
 * `method` is a 200 event stream cut `afterMs` later, without its last chunk: before any event,
 * or, `afterResult`, after the event carrying the upstream's answer. Cut at the socket, so no
 * stream errors on this side.
 */
export function startBreakingEventStreamRelay(
  upstream: string,
  opts: { method?: string; afterResult?: boolean; afterMs?: number } = {},
) {
  const method = opts.method ?? "tools/call";
  const encoder = new TextEncoder();
  const chunk = (text: string) => `${encoder.encode(text).byteLength.toString(16)}\r\n${text}\r\n`;
  /** The request `head`/`body` asks, answered on `socket`. */
  const answer = async (
    socket: { write(data: string): number; end(): void },
    head: string,
    body: string,
  ) => {
    const [requestLine = "", ...lines] = head.split("\r\n");
    const [verb = "POST", path = "/"] = requestLine.split(" ");
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0 && !/^(host|content-length|connection)$/i.test(line.slice(0, colon))) {
        headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    }
    const res = await fetch(new URL(path, upstream), {
      method: verb,
      headers,
      ...(body ? { body } : {}),
    });
    const text = await res.text();
    if (!body.includes(`"${method}"`)) {
      const type = res.headers.get("content-type") ?? "application/json";
      socket.write(
        `HTTP/1.1 ${res.status} OK\r\ncontent-type: ${type}\r\n` +
          `content-length: ${encoder.encode(text).byteLength}\r\nconnection: close\r\n\r\n${text}`,
      );
      return socket.end();
    }
    socket.write(
      "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n" +
        "transfer-encoding: chunked\r\nconnection: close\r\n\r\n" +
        // A comment sends the headers and opens the stream; the answer, when asked, follows.
        chunk(opts.afterResult ? `event: message\ndata: ${text}\n\n` : ": open\n\n"),
    );
    setTimeout(() => socket.end(), opts.afterMs ?? 50);
  };
  const server = Bun.listen<{ received: string; handled: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (socket) => void (socket.data = { received: "", handled: false }),
      data(socket, data) {
        if (socket.data.handled) return;
        socket.data.received += new TextDecoder().decode(data);
        const end = socket.data.received.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = socket.data.received.slice(0, end);
        const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
        const body = socket.data.received.slice(end + 4);
        if (encoder.encode(body).byteLength < length) return;
        socket.data.handled = true;
        void answer(socket, head, body).catch(() => socket.end());
      },
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return { url: `${origin}/mcp`, origin, stop: () => server.stop(true) };
}
