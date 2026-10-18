// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Fake MCP servers of each protocol era, as `Request → Response` handlers, for the tests of every
 * consumer of {@link createMcpHttpClient}: a legacy server (the `initialize` handshake, served by
 * the v1 SDK in stateless mode — the sidecar's own shape), a modern-only one (MCP 2026-07-28:
 * stateless, no `initialize`, version and identity in each request's `_meta` and headers,
 * `server/discover`), and a dual-era one answering both.
 *
 * The modern handler is written from the specification, not from the client SDK, so a test
 * against it checks the client's wire behaviour rather than the SDK agreeing with itself.
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
export { forgetProtocolEras } from "./client.ts";
import { parseMcpPost, serveStatelessPost } from "./streamable-post.ts";
import {
  createMcpServer,
  type AppstrateRequestExtra,
  type AppstrateToolDefinition,
} from "./index.ts";

export type McpHandler = (request: Request) => Promise<Response>;

/** The one modern revision, and the `_meta` keys it puts in every request. */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const HEADER_MISMATCH = -32020;

export interface FakeServerOptions {
  tools?: AppstrateToolDefinition[];
  serverInfo?: Implementation;
  instructions?: string;
}

export interface LegacyServerOptions extends FakeServerOptions {
  /**
   * A stateful server: `initialize` mints an `Mcp-Session-Id` the client must echo on every
   * later request (the v1 transport refuses one without it). Stateless when omitted.
   */
  stateful?: boolean;
  /** Answers each request as an SSE stream rather than one JSON body. */
  sse?: boolean;
}

/** A 2025-era server on the v1 SDK: a modern request is a 400 to it. */
export function legacyMcpHandler(opts: LegacyServerOptions = {}): McpHandler {
  const build = () =>
    createMcpServer(
      opts.tools ?? [],
      opts.serverInfo ?? { name: "fake-legacy", version: "1.0.0" },
      opts.instructions ? { instructions: opts.instructions } : {},
    );
  if (opts.stateful) {
    const server = build();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: !opts.sse,
    });
    const ready = server.connect(transport);
    return async (request) => {
      await ready;
      return transport.handleRequest(request);
    };
  }
  return async (request) => {
    // A stateless server keeps no stream for server-initiated messages.
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await request.arrayBuffer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: !opts.sse,
    });
    return serveStatelessPost(
      build(),
      transport,
      new Request(request.url, { method: "POST", headers: request.headers, body }),
      parseMcpPost(body),
    );
  };
}

export interface ModernServerOptions extends FakeServerOptions {
  /** Tools per `tools/list` page; omitted = one page. */
  pageSize?: number;
  /**
   * Answers every non-modern request (`initialize`, a POST without the modern headers, a GET):
   * a dual-era server. Omitted = modern only.
   */
  legacy?: McpHandler;
  /**
   * Refuses the first N modern requests with `UnsupportedProtocolVersion` (-32022), as a
   * server that rotated its version list would: the client must retry with a version the
   * error lists, never fall back to `initialize`.
   */
  refuseFirst?: number;
  /** Advertises no `tools` capability in `server/discover`, while still serving `tools/list`. */
  noToolsCapability?: boolean;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const rpcError = (status: number, id: unknown, code: number, message: string, data?: unknown) =>
  json(status, {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

/** A 2026-07-28 server, modern only unless `legacy` is given. */
export function modernMcpHandler(opts: ModernServerOptions = {}): McpHandler {
  const tools = opts.tools ?? [];
  const pageSize = opts.pageSize ?? Math.max(tools.length, 1);
  const serverInfo = opts.serverInfo ?? { name: "fake-modern", version: "1.0.0" };
  let refusals = opts.refuseFirst ?? 0;
  const supported = opts.legacy
    ? [MODERN_PROTOCOL_VERSION, "2025-11-25"]
    : [MODERN_PROTOCOL_VERSION];

  return async (request) => {
    if (request.method !== "POST") {
      return opts.legacy ? opts.legacy(request) : new Response(null, { status: 405 });
    }
    const text = await request.text();
    let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      message = JSON.parse(text);
    } catch {
      return rpcError(400, null, -32700, "Parse error");
    }
    const meta = message.params?._meta as Record<string, unknown> | undefined;
    const headerVersion = request.headers.get("mcp-protocol-version");
    const isModern = typeof meta?.[PROTOCOL_VERSION_KEY] === "string";
    if (!isModern) {
      if (opts.legacy) {
        return opts.legacy(
          new Request(request.url, { method: "POST", headers: request.headers, body: text }),
        );
      }
      // A modern-only server names the versions it speaks to a legacy client.
      return rpcError(
        400,
        message.id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        {
          supported,
          requested: headerVersion ?? (message.params?.protocolVersion as string | undefined),
        },
      );
    }
    const requested = meta![PROTOCOL_VERSION_KEY] as string;
    if (headerVersion !== requested) {
      return rpcError(
        400,
        message.id,
        HEADER_MISMATCH,
        "MCP-Protocol-Version does not match _meta",
      );
    }
    if (request.headers.get("mcp-method") !== message.method) {
      return rpcError(400, message.id, HEADER_MISMATCH, "Mcp-Method does not match the body");
    }
    if (refusals > 0 || !supported.includes(requested)) {
      refusals = Math.max(0, refusals - 1);
      return rpcError(
        400,
        message.id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        {
          supported,
          requested,
        },
      );
    }
    // Notifications are accepted and dropped; this revision defines none over HTTP.
    if (message.id === undefined) return new Response(null, { status: 202 });

    const result = (body: Record<string, unknown>) =>
      json(200, { jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ...body } });
    // A cacheable result (SEP-2549) states its freshness: never fresh, here.
    const cacheable = { ttlMs: 0, cacheScope: "public" };
    switch (message.method) {
      case "server/discover":
        return result({
          ...cacheable,
          supportedVersions: supported,
          capabilities: opts.noToolsCapability ? {} : { tools: { listChanged: false } },
          _meta: { [SERVER_INFO_KEY]: serverInfo },
          ...(opts.instructions ? { instructions: opts.instructions } : {}),
        });
      case "tools/list": {
        const start = Number(message.params?.cursor ?? 0);
        const end = start + pageSize;
        return result({
          ...cacheable,
          tools: tools.slice(start, end).map((tool) => tool.descriptor),
          ...(end < tools.length ? { nextCursor: String(end) } : {}),
        });
      }
      case "tools/call": {
        const name = message.params?.name;
        if (request.headers.get("mcp-name") !== name) {
          return rpcError(400, message.id, HEADER_MISMATCH, "Mcp-Name does not match the body");
        }
        const tool = tools.find((t) => t.descriptor.name === name);
        if (!tool) return rpcError(200, message.id, -32602, `Unknown tool: ${String(name)}`);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        return result(
          await tool.handler(args, { signal: request.signal } as unknown as AppstrateRequestExtra),
        );
      }
      default:
        return rpcError(404, message.id, -32601, "Method not found");
    }
  };
}

/** `fetch` answered in process by a handler: what a test injects as the client's `fetch`. */
export function handlerFetch(handler: McpHandler): typeof fetch {
  return ((input: Request | string | URL, init?: RequestInit) =>
    handler(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;
}
