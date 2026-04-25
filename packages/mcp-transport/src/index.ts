// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * `@appstrate/mcp-transport` — Appstrate ↔ Model Context Protocol bridge.
 *
 * Thin adapter that bridges the Appstrate tool registry (whose tools carry
 * raw JSON Schema input descriptors and arbitrary async handlers) to the
 * official Model Context Protocol TypeScript SDK.
 *
 * Why a wrapper at all: AFPS tools ship JSON Schema (not Zod) input shapes,
 * and the SDK's high-level `McpServer.registerTool()` only accepts Zod raw
 * shapes — converting JSON Schema → Zod just to convert it back to JSON
 * Schema on the wire is wasteful. The low-level `Server` lets us pass the
 * descriptor through verbatim, which is what `tools/list` carries anyway.
 *
 * What this module exposes:
 *
 * - `AppstrateToolDefinition` — the shape callers use to register tools.
 * - `createMcpServer(tools, info?)` — returns a `Server` with `tools/list`
 *   and `tools/call` handlers wired to the supplied registry.
 * - `createInProcessPair(tools, info?)` — convenience helper that returns a
 *   `Server` and `Client` already connected via `InMemoryTransport`. The
 *   default surface for first-party tools where subprocess overhead is
 *   unjustifiable (one of the explicit drivers behind issue #276).
 *
 * What it deliberately does *not* re-export: JSON-RPC envelope types, error
 * codes, transport implementations. Callers depend on the SDK directly for
 * those — duplicating them in this package would just create drift.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Implementation,
  type ListResourcesResult,
  type ReadResourceResult,
  type Resource,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * Handler for a single Appstrate tool. Receives validated arguments (the
 * SDK does not validate input against `inputSchema` automatically — the
 * caller must `.parse()` inside the handler if it needs strict checking)
 * and the SDK's `RequestHandlerExtra` (carries the per-request
 * `AbortSignal`, `requestId`, `_meta`, and auth info) so handlers that
 * care about cancellation or correlation can opt in.
 *
 * Thrown errors become JSON-RPC `InternalError` responses; tool-level
 * errors that the model should still see should be returned as
 * `{ content: [...], isError: true }` instead of being thrown.
 */
export type AppstrateRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type AppstrateToolHandler = (
  args: Record<string, unknown>,
  extra: AppstrateRequestExtra,
) => Promise<CallToolResult>;

/**
 * Tool registration shape — pairs the wire-format `Tool` descriptor with
 * the in-process handler that fulfils it.
 */
export interface AppstrateToolDefinition {
  /**
   * MCP `Tool` descriptor as it appears in `tools/list`. The SDK requires
   * `name` and `inputSchema`; everything else (`description`, `title`,
   * `annotations`) is optional.
   */
  descriptor: Tool;
  handler: AppstrateToolHandler;
}

const DEFAULT_SERVER_INFO: Implementation = {
  name: "appstrate-mcp-server",
  version: "0.0.0",
};

// MCP `Tool.name` must be a non-empty string. The spec doesn't pin a
// regex, but every reference implementation we've audited rejects names
// containing whitespace or control characters, and they would round-trip
// poorly through any client that surfaces the name in a generated symbol.
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

function validateDescriptor(descriptor: Tool): void {
  if (typeof descriptor.name !== "string" || !TOOL_NAME_PATTERN.test(descriptor.name)) {
    throw new Error(
      `createMcpServer: tool name must match ${TOOL_NAME_PATTERN} (got '${String(descriptor.name)}')`,
    );
  }
  // MCP spec (2025-06-18+) requires `inputSchema` to be a JSON-Schema
  // object whose root type is `"object"`. The SDK does not enforce this
  // at registration time — a malformed schema would only surface during
  // a `tools/call` arg validation failure or, worse, succeed silently if
  // the LLM happens to send a matching shape. Catch it eagerly.
  const schema = descriptor.inputSchema as Record<string, unknown> | undefined;
  if (!schema || typeof schema !== "object" || schema.type !== "object") {
    throw new Error(
      `createMcpServer: tool '${descriptor.name}' must declare inputSchema with { type: "object" }`,
    );
  }
}

/**
 * Resource provider hooks. Pass `resources` to
 * `createMcpServer` to expose `resources/list` and `resources/read`.
 *
 * - `list()` is called whenever the client invokes `resources/list`. It
 *   returns the *currently* enumerable resources — the agent never
 *   sees ephemeral `resource_link` blocks here per spec, so blob caches
 *   typically return `[]` and rely on `resource_link` from tool results.
 * - `read(uri, extra)` is called for `resources/read`. Return one or
 *   more `contents` blocks. Throw an `McpError(ErrorCode.InvalidParams)`
 *   for not-found (so the SDK serialises a clean -32602) — never
 *   silently return empty.
 */
export interface AppstrateResourceProvider {
  list?: (extra: AppstrateRequestExtra) => Promise<Resource[]> | Resource[];
  read: (
    uri: string,
    extra: AppstrateRequestExtra,
  ) => Promise<ReadResourceResult> | ReadResourceResult;
}

export interface CreateMcpServerOptions {
  /** Resource provider — when omitted, no `resources/*` capability is advertised. */
  resources?: AppstrateResourceProvider;
}

/**
 * Build an MCP `Server` that exposes the supplied tool definitions via
 * `tools/list` and `tools/call`. The server is *not* yet connected to a
 * transport — the caller decides whether to wire it through
 * `InMemoryTransport`, stdio, or HTTP.
 *
 * Duplicate tool names throw eagerly (silent overrides hide adapter bugs
 * in whichever layer aggregates Appstrate's per-package registries).
 */
export function createMcpServer(
  tools: ReadonlyArray<AppstrateToolDefinition>,
  serverInfo: Implementation = DEFAULT_SERVER_INFO,
  options: CreateMcpServerOptions = {},
): Server {
  const registry = new Map<string, AppstrateToolDefinition>();
  for (const tool of tools) {
    validateDescriptor(tool.descriptor);
    if (registry.has(tool.descriptor.name)) {
      throw new Error(`createMcpServer: duplicate tool registration for '${tool.descriptor.name}'`);
    }
    registry.set(tool.descriptor.name, tool);
  }

  const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
  if (options.resources) {
    capabilities.resources = { listChanged: false, subscribe: false };
  }

  const server = new Server(serverInfo, { capabilities });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()].map((t) => t.descriptor),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const reg = registry.get(request.params.name);
    if (!reg) {
      // MethodNotFound is the closest standard code for "this method
      // exists, but the named tool does not". Per MCP convention, callers
      // distinguish unknown-tool from unknown-method via the error message
      // (the SDK does not reserve a separate code).
      throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
    }
    return reg.handler(request.params.arguments ?? {}, extra);
  });

  if (options.resources) {
    const provider = options.resources;
    server.setRequestHandler(ListResourcesRequestSchema, async (_req, extra) => {
      const list = (await provider.list?.(extra)) ?? [];
      return { resources: list } satisfies ListResourcesResult;
    });
    server.setRequestHandler(ReadResourceRequestSchema, async (req, extra) => {
      return provider.read(req.params.uri, extra);
    });
  }

  return server;
}

/** A connected `(server, client)` pair sharing an in-memory transport. */
export interface InProcessMcpPair {
  server: Server;
  client: Client;
  /** Closes both transports. Idempotent. */
  close(): Promise<void>;
}

/**
 * Build a server-and-client pair already bridged by
 * `InMemoryTransport.createLinkedPair()`.
 *
 * Use this for first-party tools where the subprocess hop a stdio
 * transport implies has no payoff: same Bun process on both sides, no
 * isolation boundary worth crossing, but full MCP wire-format compliance
 * so swapping to `StdioClientTransport` for third-party MCP servers is a
 * one-line change.
 */
export async function createInProcessPair(
  tools: ReadonlyArray<AppstrateToolDefinition>,
  options: {
    serverInfo?: Implementation;
    clientInfo?: Implementation;
  } = {},
): Promise<InProcessMcpPair> {
  const server = createMcpServer(tools, options.serverInfo);
  const client = new Client(
    options.clientInfo ?? { name: "appstrate-mcp-client", version: "0.0.0" },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    server,
    client,
    async close() {
      // `client.close()` shuts the protocol down on its side; the server's
      // transport closes via the linked pair's `onclose` propagation.
      await client.close();
      await server.close();
    },
  };
}

// Re-export the SDK error primitives so callers don't need a second
// dependency line just to inspect error codes thrown by the server.
export { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
export type {
  CallToolResult,
  Implementation,
  ReadResourceResult,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

// AFPS bridge — convert spec-shaped tools into MCP definitions without
// rewriting them. Used by Phase 2 to mount existing AFPS tools through
// the MCP wire format.
export {
  fromAfpsTool,
  type AfpsContextProvider,
  type FromAfpsToolOptions,
} from "./afps-adapter.ts";

// MCP client factories. The agent connects to the sidecar's `/mcp`
// over Streamable HTTP; the CLI uses the in-process pair already
// exported above.
export {
  createMcpHttpClient,
  wrapClient,
  type AppstrateMcpClient,
  type AppstrateMcpClientOptions,
  type McpHttpClientOptions,
} from "./client.ts";

// Subprocess transport — spawn a third-party MCP server as a child
// process and speak newline-delimited JSON-RPC over stdio. Compatible
// with the SDK's Transport interface so the same `Client` works against
// http or subprocess servers without refactor.
export {
  SubprocessTransport,
  SubprocessTransportError,
  type SubprocessTransportOptions,
} from "./transports/subprocess.ts";

// Manifest-driven loader — lets a tool package declare itself as a
// subprocess MCP server in its manifest's `definition` block; one helper
// spawns + connects + wraps in a vetted AppstrateMcpClient.
export {
  MCP_SERVER_RUNTIME,
  TRANSPORTS,
  TRUST_LEVELS,
  isMcpServerManifestDefinition,
  parseMcpServerManifest,
  type ManifestTransport,
  type McpServerManifest,
  type TrustLevel,
} from "./manifest.ts";
export { loadToolMcpServer, type LoadToolMcpServerOptions } from "./loader.ts";

// Tool descriptor sanitisation — strip hidden Unicode, cap field
// lengths, defeat Full-Schema Poisoning before any third-party tool
// descriptor reaches the agent's LLM.
export {
  sanitiseTextField,
  sanitiseToolDescriptor,
  MAX_TOOL_DESCRIPTION_BYTES,
  MAX_PARAMETER_DESCRIPTION_BYTES,
  MAX_SCHEMA_SERIALISED_BYTES,
} from "./sanitize.ts";
