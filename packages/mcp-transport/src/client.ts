// SPDX-License-Identifier: Apache-2.0

/**
 * MCP client factories for first-party callers (Phase 2 of #276).
 *
 * Two transports, one client surface. The wiring code in `runtime-pi`
 * branches on transport construction only — `listTools`, `callTool`,
 * `readResource`, and `close` are identical across both modes:
 *
 * - `createMcpHttpClient(...)` — Streamable HTTP against the sidecar's
 *   `/mcp` endpoint. Used inside the agent container.
 * - `createInProcessPair(...)` (already exported from `./index.ts`) —
 *   `InMemoryTransport` for CLI mode where the sidecar is in-process.
 *
 * Both return an `AppstrateMcpClient` carrying a connected SDK `Client`.
 * Cancellation is honored via `AbortSignal` on every call site — the SDK
 * propagates it as `notifications/cancelled` to the server.
 *
 * What this module deliberately does *not* do:
 *
 * - Implement reconnection logic. Stateless transport per request on the
 *   server side means the connection is cheap; on transient errors the
 *   caller decides whether to retry.
 * - Implement OAuth. Sidecar auth is per-run Bearer (constant-time
 *   compared on the server, opaque to the client).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  Implementation,
  ReadResourceResult,
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_CLIENT_INFO: Implementation = {
  name: "appstrate-mcp-client",
  version: "0.0.0",
};

/** Options shared by every client factory in this module. */
export interface AppstrateMcpClientOptions {
  /** Identification advertised to the server during `initialize`. */
  clientInfo?: Implementation;
  /**
   * Per-call timeout in milliseconds. Defaults to 30s — matches the
   * `/proxy` upstream timeout. The SDK aborts the underlying fetch if
   * the timeout fires.
   */
  defaultTimeoutMs?: number;
}

/** Options for `createMcpHttpClient`. */
export interface McpHttpClientOptions extends AppstrateMcpClientOptions {
  /** Per-run Bearer token. Sent as `Authorization: Bearer <token>`. */
  bearerToken?: string;
  /** Optional `fetch` override (tests inject a mock). */
  fetch?: typeof fetch;
  /** Extra headers to merge into every request. */
  extraHeaders?: Record<string, string>;
}

/**
 * The narrowed surface `runtime-pi` consumes. Wraps the SDK `Client` to:
 *
 *   1. Force every call to thread an `AbortSignal` (reuses the Pi
 *      `execute(_, _, signal)` contract — agents must be cancellable).
 *   2. Centralise the `Implementation` info advertised on `initialize`.
 *   3. Provide a single `close()` that tears down both client + transport.
 */
export interface AppstrateMcpClient {
  /** The connected SDK `Client`. Exposed for advanced use cases. */
  readonly client: Client;
  /**
   * Server capabilities snapshotted during the MCP `initialize`
   * handshake. Returns `undefined` if the client hasn't completed
   * `connect()` yet — callers must check before branching on
   * `tools` / `resources` / `prompts` / `logging` support.
   *
   * Phase 6 (#276): the agent uses this to skip `resources/list`
   * against servers that didn't advertise the capability instead of
   * paying for a round-trip + JSON-RPC error.
   */
  getServerCapabilities(): ServerCapabilities | undefined;
  /**
   * Server `Implementation` (`{ name, version }`) snapshotted during
   * `initialize`. Used by McpHost log lines so operators can audit
   * which upstream version is actually connected.
   */
  getServerVersion(): Implementation | undefined;
  /** List server-advertised tools. */
  listTools(options?: { signal?: AbortSignal }): Promise<{ tools: Tool[] }>;
  /** Invoke a tool by name. */
  callTool(
    args: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<CallToolResult>;
  /** Read a resource by URI. */
  readResource(
    args: { uri: string },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ReadResourceResult>;
  /** Close the transport. Idempotent. */
  close(): Promise<void>;
}

/**
 * Connect a fresh MCP client to an HTTP server (Streamable HTTP).
 *
 * The transport uses the `Authorization: Bearer <token>` header when a
 * `bearerToken` is supplied. The server is expected to validate it with
 * a constant-time compare and respond `401` on miss — the caller must
 * surface 401 as a fatal config error (no retry, no fallback).
 *
 * The returned client is **already connected** (we await
 * `client.connect()`). On error, the partially-constructed transport is
 * cleaned up before the error propagates.
 */
export async function createMcpHttpClient(
  url: string | URL,
  options: McpHttpClientOptions = {},
): Promise<AppstrateMcpClient> {
  const targetUrl = url instanceof URL ? url : new URL(url);

  const headers: Record<string, string> = { ...(options.extraHeaders ?? {}) };
  if (options.bearerToken) {
    headers.Authorization = `Bearer ${options.bearerToken}`;
  }

  const transport = new StreamableHTTPClientTransport(targetUrl, {
    requestInit: { headers },
    ...(options.fetch ? { fetch: options.fetch as never } : {}),
  });

  const client = new Client(options.clientInfo ?? DEFAULT_CLIENT_INFO);

  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw err;
  }

  return wrapClient(client, transport, options.defaultTimeoutMs);
}

/**
 * Wrap a connected SDK `Client` (regardless of transport) in the
 * `AppstrateMcpClient` surface. Used by both HTTP and in-memory
 * factories so cancellation + timeout semantics are identical.
 */
export function wrapClient(
  client: Client,
  transport: { close(): Promise<void> },
  defaultTimeoutMs?: number,
): AppstrateMcpClient {
  let closed = false;
  return {
    client,
    getServerCapabilities() {
      return client.getServerCapabilities();
    },
    getServerVersion() {
      return client.getServerVersion();
    },
    async listTools(options) {
      const result = await client.listTools(undefined, {
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      return { tools: result.tools };
    },
    async callTool(args, options) {
      return client.callTool(args, undefined, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...((options?.timeoutMs ?? defaultTimeoutMs)
          ? { timeout: options?.timeoutMs ?? defaultTimeoutMs }
          : {}),
      }) as Promise<CallToolResult>;
    },
    async readResource(args, options) {
      return client.readResource(args, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...((options?.timeoutMs ?? defaultTimeoutMs)
          ? { timeout: options?.timeoutMs ?? defaultTimeoutMs }
          : {}),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
