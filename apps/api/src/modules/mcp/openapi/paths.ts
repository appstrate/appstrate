// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI paths for the MCP module's own endpoints. These document the
 * transport + discovery surface for human/API consumers; the platform's
 * ~250 operations are NOT re-listed here — they are discovered at runtime
 * through the `search_operations` / `describe_operation` MCP tools, with
 * `run_and_wait` as the run-launch shortcut.
 */

const jsonRpcRequestBody = {
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

/**
 * A refusal the MCP SDK transport answers itself, before any tool runs: a
 * JSON-RPC 2.0 error envelope with `id: null` (the request was never accepted).
 */
function jsonRpcTransportError(description: string) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          type: "object",
          description: "A JSON-RPC 2.0 error envelope.",
          properties: {
            jsonrpc: { type: "string", enum: ["2.0"] },
            id: { type: "null" },
            error: {
              type: "object",
              properties: {
                code: { type: "integer" },
                message: { type: "string" },
                data: {},
              },
              required: ["code", "message"],
            },
          },
          required: ["jsonrpc", "id", "error"],
        },
      },
    },
  } as const;
}

const orgPathParameter = {
  name: "org",
  in: "path",
  required: true,
  description: "Organization id (uuid). Identifies the organization this MCP endpoint is bound to.",
  schema: { type: "string" },
} as const;

export const mcpPaths = {
  "/api/mcp/o/{org}": {
    post: {
      operationId: "mcpStreamableHttpPost",
      tags: ["MCP"],
      summary: "Per-organization MCP Streamable HTTP endpoint",
      description:
        "Model Context Protocol server (Streamable HTTP, stateless) for a single organization. " +
        "Accepts JSON-RPC 2.0 messages (`initialize`, `tools/list`, `tools/call`). The tools it " +
        "declares follow the caller's permissions: the read-only set (`search_operations`, " +
        "`describe_operation`, `read_file`, `read_skill`, `validate_package_file`, " +
        "`get_runtime_capabilities`, " +
        "and `get_me` unless the client injects its own caller context) is always present, " +
        "while the acting tools — `invoke_operation` (`mcp:invoke`), " +
        "`run_and_wait` (`mcp:invoke` plus `agents:run` and a run-read permission), `list_files` " +
        "(whatever guards the `listFiles` operation's own route) and `import_package_file` — are " +
        "declared only to a caller whose grants make them usable, so `tools/list` differs by " +
        "role. Together they let an MCP client discover and call platform API operations, " +
        "plus launch and wait for agent runs, with the caller's own credentials and confined to " +
        "the organization in the path. Each organization has its own endpoint: a " +
        "token obtained for this endpoint is audience-bound (RFC 8707) to the per-org resource " +
        "URI `<APP_URL>/api/mcp/o/{org}` and cannot drive any other organization. To use several " +
        "organizations, configure one MCP server entry per organization. Requires the `mcp:read` " +
        "permission (and `mcp:invoke` to call operations).",
      security: [{ bearerJwt: [] }, { bearerApiKey: [] }, { cookieAuth: [] }],
      parameters: [orgPathParameter],
      requestBody: jsonRpcRequestBody,
      responses: {
        "200": {
          description:
            "JSON-RPC response. Served as `text/event-stream` when a request carries " +
            "`params._meta.progressToken`: its progress notifications, then its result, as SSE " +
            "events; as `application/json` otherwise.",
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
            "text/event-stream": { schema: { type: "string" } },
          },
        },
        "400": jsonRpcTransportError(
          "Unparseable JSON (`-32700`), an invalid JSON-RPC message or batch (`-32700`/`-32600`), " +
            "or an unsupported `MCP-Protocol-Version` header (`-32000`).",
        ),
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "406": jsonRpcTransportError(
          "`Accept` does not list both `application/json` and `text/event-stream` (`-32000`).",
        ),
        "413": {
          description:
            "`payload_too_large` — the request body exceeds the global `API_BODY_LIMIT_BYTES` cap " +
            "(enforced by the body-limit middleware, before the MCP transport).",
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
        "415": jsonRpcTransportError("`Content-Type` is not `application/json` (`-32000`)."),
      },
    },
    get: {
      operationId: "mcpStreamableHttpGet",
      tags: ["MCP"],
      summary: "Per-organization MCP Streamable HTTP (GET)",
      description:
        "The GET channel of the per-organization MCP Streamable HTTP transport. This server runs " +
        "in stateless mode (no standalone server-initiated SSE stream), so GET returns 405; " +
        "clients POST JSON-RPC messages instead. Requires the `mcp:read` permission.",
      security: [{ bearerJwt: [] }, { bearerApiKey: [] }, { cookieAuth: [] }],
      parameters: [orgPathParameter],
      responses: {
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "405": {
          description:
            "`method_not_allowed` — the stateless server has no GET stream; `Allow: POST`.",
          headers: { Allow: { schema: { type: "string", example: "POST" } } },
          content: {
            "application/problem+json": { schema: { $ref: "#/components/schemas/ProblemDetail" } },
          },
        },
      },
    },
  },
  "/.well-known/oauth-protected-resource/api/mcp/o/{org}": {
    get: {
      operationId: "mcpProtectedResourceMetadata",
      tags: ["MCP"],
      summary: "OAuth 2.0 Protected Resource Metadata (RFC 9728)",
      description:
        "Public discovery document advertising the authorization server that protects the " +
        "per-organization MCP endpoint, so spec-compliant MCP clients can complete an OAuth flow " +
        "without manual configuration. The advertised `resource` is the per-org URI " +
        "`<APP_URL>/api/mcp/o/{org}`, which tokens are audience-bound to (RFC 8707).",
      parameters: [orgPathParameter],
      responses: {
        "200": {
          description: "Protected resource metadata.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  resource: { type: "string", format: "uri" },
                  authorization_servers: {
                    type: "array",
                    items: { type: "string", format: "uri" },
                  },
                  scopes_supported: { type: "array", items: { type: "string" } },
                  bearer_methods_supported: { type: "array", items: { type: "string" } },
                  resource_documentation: { type: "string", format: "uri" },
                },
                required: ["resource", "authorization_servers"],
              },
            },
          },
        },
      },
    },
  },
} as const;
