// SPDX-License-Identifier: Apache-2.0

/**
 * The parts of the run MCP server's operation (`services/run-tools-mcp.ts`)
 * shared by its two mounts: `POST /internal/mcp` and `POST /api/runs/{runId}/mcp`.
 */

import { jsonRpcTransportError, problemContent } from "../responses.ts";

export const RUN_TOOLS_MCP_DESCRIPTION =
  "Model Context Protocol server (Streamable HTTP, stateless) serving the tools of the " +
  "`@appstrate/platform` system integration — `log`, `note`, `pin`, `recall_memory`, " +
  "`run_history`, `notify` — for one run. Each tool writes at call time: `log` appends a run " +
  "log, `note` an archive memory, `pin` a pinned slot and, for the `checkpoint` key, the run's " +
  "checkpoint snapshot that `run_history` returns, `notify` an `agent_message` notification to " +
  "each recipient of the run's completion notification, once per run. Rate-limited to 200 " +
  "requests a minute per run, one JSON-RPC message per request: a batch (a JSON array) " +
  "is refused with 400 (`-32600`).";

export const runToolsMcpRequestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        description: "A JSON-RPC 2.0 request envelope (MCP Streamable HTTP).",
        properties: {
          jsonrpc: { type: "string", enum: ["2.0"] },
          id: { type: ["string", "number", "null"] },
          method: { type: "string" },
          params: { type: "object", additionalProperties: true },
        },
        required: ["jsonrpc", "method"],
      },
    },
  },
} as const;

/** What the MCP transport and the platform's request pipeline answer on either mount. */
export const runToolsMcpResponses = {
  "200": {
    description:
      "JSON-RPC response. Served as `text/event-stream` when a request carries " +
      "`params._meta.progressToken`, as `application/json` otherwise.",
    content: {
      "application/json": { schema: { type: "object", additionalProperties: true } },
      "text/event-stream": { schema: { type: "string" } },
    },
  },
  "202": {
    description:
      "The body held only JSON-RPC notifications or responses (e.g. `notifications/initialized`): accepted, no body.",
  },
  "400": {
    description:
      "`application/json`: the MCP transport's JSON-RPC error — unparseable JSON (`-32700`), an " +
      "invalid JSON-RPC message (`-32700`/`-32600`), a batch (`-32600`), or an unsupported " +
      "`MCP-Protocol-Version` header (`-32000`). `application/problem+json`: a request the " +
      "platform refuses before the transport.",
    content: {
      ...jsonRpcTransportError("").content,
      ...problemContent,
    },
  },
  "406": jsonRpcTransportError(
    "`Accept` does not list both `application/json` and `text/event-stream` (`-32000`).",
  ),
  "413": {
    description:
      "`payload_too_large` — the request body exceeds the global `API_BODY_LIMIT_BYTES` cap " +
      "(enforced by the body-limit middleware, before the MCP transport).",
    content: problemContent,
  },
  "415": jsonRpcTransportError("`Content-Type` is not `application/json` (`-32000`)."),
  "429": { $ref: "#/components/responses/RateLimited" },
} as const;

/** The GET (and every other non-POST verb) of either mount. */
export const runToolsMcpMethodNotAllowed = {
  description: "`method_not_allowed` — the stateless server has no GET stream; `Allow: POST`.",
  headers: { Allow: { schema: { type: "string", example: "POST" } } },
  content: problemContent,
} as const;
