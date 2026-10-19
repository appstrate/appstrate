# `@appstrate/mcp-transport`

Thin adapter on top of the official `@modelcontextprotocol/sdk` that lets
Appstrate components register their tools and consume them through the
**Model Context Protocol** wire format with zero bespoke JSON-RPC code.

## Why a wrapper at all?

The official SDK already ships every JSON-RPC primitive, error code, and
in-memory transport we need. Two small impedance mismatches motivated
this package:

1. **JSON Schema input.** Appstrate tool definitions ship raw JSON
   Schema. The SDK's high-level `McpServer.registerTool()` only accepts
   Zod raw shapes — going through it would force a JSON Schema → Zod →
   JSON Schema round-trip on the wire. The low-level `Server` lets us
   pass the descriptor through verbatim.

2. **Eager validation.** The SDK does not enforce
   `inputSchema.type === "object"` at registration time — a malformed
   schema only surfaces as a runtime `tools/call` failure. We catch it
   at registration so misuse fails fast.

## Quick start

### Register tool definitions

```ts
import { createInProcessPair } from "@appstrate/mcp-transport";

const pair = await createInProcessPair([
  {
    descriptor: {
      name: "echo",
      description: "Echoes the input message verbatim.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    handler: async (args) => ({
      content: [{ type: "text", text: String(args.message) }],
    }),
  },
]);

const result = await pair.client.callTool({
  name: "echo",
  arguments: { message: "hi" },
});
// → { content: [{ type: "text", text: "hi" }] }

await pair.close();
```

### Build a Server without an in-process client

When you need to expose tools over an HTTP/stdio/subprocess transport,
use `createMcpServer()` directly:

A stateless endpoint builds a fresh pair per request. `parseMcpPost` reads
the body once and tells whether a request asked for progress; answer JSON
unless it did, and let `serveStatelessPost` serve it — it closes the pair at
once for JSON, and only once the stream is over for SSE:

```ts
import { createMcpServer, parseMcpPost, serveStatelessPost } from "@appstrate/mcp-transport";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

app.post("/mcp", async (c) => {
  const body = await c.req.arrayBuffer();
  const post = parseMcpPost(body);
  const server = createMcpServer(tools, { name: "my-server", version: "1.0" });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: !post?.requestsProgress, // SSE only when progress was asked for
  });
  const request = new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body });
  return serveStatelessPost(server, transport, request, post);
});
```

The platform's MCP router and the sidecar (`runtime-pi/sidecar/mcp.ts`) both
serve POSTs this way. A tool handler reports progress without risking its
result with `notifyDetached(extra, notification, onError)`, and a client
requests it per call with `callTool(args, { onProgress })` — which also turns
the call's timeout into an idle timeout.

## API surface

### `createMcpServer(tools, info?)`

Builds an SDK `Server` with `tools/list` + `tools/call` handlers wired to
the supplied registry. Validates each descriptor (non-empty name, valid
character set, `inputSchema.type === "object"`) and rejects duplicates.

### `createInProcessPair(tools, options?)`

Convenience: returns `{ server, client, close }` where both halves are
already connected via `InMemoryTransport.createLinkedPair()`. Used for
first-party tools where subprocess overhead is unjustifiable.

### `createMcpHttpClient(url, options?)`

A connected `AppstrateMcpClient` over Streamable HTTP, on the v2 client SDK
(`@modelcontextprotocol/client`). This section is the reference for how it
picks a **protocol era**; other documents link here rather than restate it.

- **Negotiation** is the SDK's `'auto'` mode: a `server/discover` probe in the
  MCP 2026-07-28 shape (stateless; version and identity in each request's
  `_meta` and `MCP-Protocol-Version` header). A result, or an
  `UnsupportedProtocolVersion` (-32022) listing a version both sides speak
  (retried with it), keeps the connection modern. Anything else falls back to
  the 2025 `initialize` handshake.
- **Inconclusive probe**: a probe answered 5xx, or unanswered within 10 s (or
  the caller's `defaultTimeoutMs`, when lower), is no era evidence. The client
  tries `initialize` once. If that fails too, its error is surfaced when it
  says more than the probe did (an auth refusal, a fault of the injected
  `fetch`, a 5xx); otherwise the probe's is, so a transient 5xx stays
  retryable.
- **Legacy verdict cache**: an origin found legacy, by the probe or by that
  fallback, is remembered for 15 minutes. Its next connects skip the probe.
  The verdict is never renewed by those connects, so a server that upgrades is
  re-probed when it expires. A remembered origin that refuses `initialize`
  with a 4xx other than 401/403 is re-probed at once; an outage (refused
  connection, timeout, 5xx) keeps the verdict and surfaces its own error.
- **`era: "legacy"`** skips the probe, for a first-party server legacy by
  construction (the sidecar's `/mcp`, the platform MCP module).

`getProtocol()` says which era was negotiated.

**Tools.** `tools/list` pages are raw requests, never the SDK's `listTools()`
(which answers `[]` to a server advertising no `tools` capability).
`listTools()` walks every page, up to 64, and throws past that. On a modern
connection a tool with an invalid `x-mcp-header` is excluded and reported
through `onWarning`. A server repeating its cursor throws too, never a
partial list. The definitions of the session's last listing are handed to
each `callTool`: the SDK validates the output against the tool's
`outputSchema` in both eras, and on a modern connection mirrors `x-mcp-header`
parameters. A modern call made before any listing gets both only through the
SDK's own recovery, so list first (current consumers do). A tool whose
`outputSchema` cannot compile is refused before the call is sent. A
`HeaderMismatch` (-32020) on a modern call refreshes the list and resends the
call once. On a legacy connection -32020 is the server's own error and is
never resent.

Credentials and egress belong to the injected `fetch` (the credential proxy):
the SDK is never given an auth provider and leaves redirects to it. A fault
the injected fetch throws during the connect comes back as itself.

`wrapClient(client, transport)` gives the same surface over a connected v1
SDK `Client`: in-process pairs, stdio subprocesses, the HTTP+SSE transport.
Their servers are 2025-era by construction. `listTools()` walks the pages
there too, and the v1 client validates outputs against every page's tools.

### `@appstrate/mcp-transport/testing`

Fake servers of each era as `Request → Response` handlers, for consumer
tests: `legacyMcpHandler` (v1 SDK, stateless), `modernMcpHandler` (written
from the 2026-07-28 spec; `legacy` makes it dual-era, `refuseFirst` answers
-32022 first), both paginating by `pageSize`, `handlerFetch`, and
`forgetProtocolEras()` to reset the per-origin era cache between tests.

### Re-exports from the SDK

```ts
import { McpError, ErrorCode } from "@appstrate/mcp-transport";
import type { CallToolResult, Tool } from "@appstrate/mcp-transport";
```

For everything else — server transports, request schemas — import directly
from `@modelcontextprotocol/sdk` (the server side stays on v1).

## Stability

Public API is stable across minor versions. Breaking changes land behind
a major version bump.

## License

Apache-2.0
