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
        "Accepts JSON-RPC 2.0 messages (`initialize`, `tools/list`, `tools/call`). Exposes four " +
        "tools — `search_operations`, `describe_operation`, `invoke_operation`, and " +
        "`run_and_wait` — that let an MCP client discover and call platform API operations, " +
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
          description: "JSON-RPC response.",
          content: {
            "application/json": { schema: { type: "object", additionalProperties: true } },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
        "405": { description: "Method Not Allowed — stateless server has no GET stream." },
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
