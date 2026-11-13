// SPDX-License-Identifier: Apache-2.0

/**
 * The parts of the run MCP server's operation (`services/run-tools-mcp.ts`)
 * shared by its two mounts: `POST /internal/mcp` and `POST /api/runs/{runId}/mcp`.
 */

export const RUN_TOOLS_MCP_DESCRIPTION =
  "Model Context Protocol server (Streamable HTTP, stateless) serving the tools of the " +
  "`@appstrate/platform` system integration — `log`, `note`, `pin`, `recall_memory`, " +
  "`run_history` — for one `running` run. Each tool writes at call time: `log` appends a run " +
  "log, `note` an archive memory, `pin` a pinned slot and, for the `checkpoint` key, the run's " +
  "checkpoint snapshot that `run_history` returns.";

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
  "400": {
    description:
      "`application/json`: the MCP transport's JSON-RPC error — unparseable JSON, an invalid " +
      "JSON-RPC message, or an unsupported `MCP-Protocol-Version` header. " +
      "`application/problem+json`: a request the platform refuses before the transport.",
    content: {
      "application/json": { schema: { type: "object", additionalProperties: true } },
      "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
    },
  },
} as const;
