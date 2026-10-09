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

### Re-exports from the SDK

```ts
import { McpError, ErrorCode } from "@appstrate/mcp-transport";
import type { CallToolResult, Tool } from "@appstrate/mcp-transport";
```

For everything else — transports, request schemas, the `Client` class —
import directly from `@modelcontextprotocol/sdk`.

## Stability

Public API is stable across minor versions. Breaking changes land behind
a major version bump.

## License

Apache-2.0
