# `@appstrate/mcp-transport`

Thin adapter on top of the official `@modelcontextprotocol/sdk` that lets
Appstrate components register their tools and consume them through the
**Model Context Protocol** wire format with zero bespoke JSON-RPC code.

## Why a wrapper at all?

The official SDK already ships every JSON-RPC primitive, error code, and
in-memory transport we need. Three small impedance mismatches motivated
this package:

1. **JSON Schema input.** AFPS tools (`@afps-spec/types`) ship raw JSON
   Schema. The SDK's high-level `McpServer.registerTool()` only accepts
   Zod raw shapes — going through it would force a JSON Schema → Zod →
   JSON Schema round-trip on the wire. The low-level `Server` lets us
   pass the descriptor through verbatim.

2. **AFPS Tool ↔ MCP Tool shape.** The two are 90% aligned by design
   (the AFPS spec docstring says `ToolResult.content` "mirrors the
   MCP/Anthropic tool-result format"). The remaining 10% (`parameters →
inputSchema`, AFPS `resource` → MCP `resource_link`, `ToolContext`
   threading) is mechanical and centralised in `fromAfpsTool()`.

3. **Eager validation.** The SDK does not enforce
   `inputSchema.type === "object"` at registration time — a malformed
   schema only surfaces as a runtime `tools/call` failure. We catch it
   at registration so misuse fails fast.

## Quick start

### Register raw MCP tool definitions

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

### Register an existing AFPS Tool

```ts
import { createInProcessPair, fromAfpsTool } from "@appstrate/mcp-transport";
import type { Tool as AfpsTool } from "@afps-spec/types";

declare const myAfpsTool: AfpsTool; // already implemented elsewhere

const pair = await createInProcessPair([
  fromAfpsTool(myAfpsTool, {
    runId: currentRunId,
    workspace: runWorkspace,
    emit: runEventSink.handle,
  }),
]);
```

The MCP request `signal` is threaded into the AFPS `ToolContext` so any
tool that respects cancellation per AFPS §6.2 keeps working unchanged.

### Build a Server without an in-process client

When you need to expose tools over an HTTP/stdio/subprocess transport,
use `createMcpServer()` directly:

```ts
import { createMcpServer } from "@appstrate/mcp-transport";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const server = createMcpServer(tools, { name: "my-server", version: "1.0" });
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless
  enableJsonResponse: true,
});
await server.connect(transport);

// In a Hono handler:
app.all("/mcp", (c) => transport.handleRequest(c.req.raw));
```

The Appstrate sidecar uses exactly this pattern in `runtime-pi/sidecar/mcp.ts`.

## API surface

### `createMcpServer(tools, info?)`

Builds an SDK `Server` with `tools/list` + `tools/call` handlers wired to
the supplied registry. Validates each descriptor (non-empty name, valid
character set, `inputSchema.type === "object"`) and rejects duplicates.

### `createInProcessPair(tools, options?)`

Convenience: returns `{ server, client, close }` where both halves are
already connected via `InMemoryTransport.createLinkedPair()`. Used for
first-party tools where subprocess overhead is unjustifiable.

### `fromAfpsTool(tool, options)`

Converts an AFPS `Tool` into an `AppstrateToolDefinition`. Maps:

| AFPS                           | MCP                            |
| ------------------------------ | ------------------------------ |
| `name`, `description`          | same                           |
| `parameters` (JSON Schema)     | `inputSchema`                  |
| `execute(args, ctx)`           | `handler(args, extra)`         |
| `{ type: "resource", uri, … }` | `{ type: "resource_link", … }` |
| `ToolResult.isError`           | `CallToolResult.isError`       |

The `signal`, `runId`, `workspace`, `emit`, and `toolCallId` fields of
`ToolContext` are supplied via `options` (a context provider can be
overridden for advanced cases).

### Re-exports from the SDK

```ts
import { McpError, ErrorCode } from "@appstrate/mcp-transport";
import type { CallToolResult, Tool } from "@appstrate/mcp-transport";
```

For everything else — transports, request schemas, the `Client` class —
import directly from `@modelcontextprotocol/sdk`.

## Why this lives in `@appstrate/mcp-transport`, not `@appstrate/afps-runtime`

`afps-runtime` ships with **zero MCP knowledge** by design — it is the
framework-agnostic spec runtime. Pulling in the MCP SDK from there
would add MCP as a hard dependency for every consumer of the spec
runtime (CLI bundles, tests, registry verification). Keeping the
dependency direction `mcp-transport → afps-runtime types` preserves that
isolation.

## Stability

Public API is stable across minor versions. Breaking changes land behind
a major version bump.

## License

Apache-2.0
