// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI contribution for the search module. Documented here = reachable over
 * MCP via the `mcp` module's meta-tools (`invoke_operation`) — agents query the
 * index through the same surface as the UI and the chat RAG path.
 */

const stdHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
} as const;

export const searchComponentSchemas = {
  SearchHit: {
    type: "object",
    required: ["object", "chunkId", "storageObjectId", "chunkIndex", "content"],
    properties: {
      object: { type: "string", enum: ["search_hit"] },
      chunkId: { type: "string", description: "The matched chunk id" },
      storageObjectId: {
        type: "string",
        description: "Opaque storage object id — read its bytes via the storage API",
      },
      name: { type: ["string", "null"], description: "Object name at index time" },
      chunkIndex: { type: "integer" },
      content: { type: "string", description: "The chunk text" },
    },
  },
} as const;

export const searchPaths = {
  "/api/search": {
    post: {
      operationId: "search",
      tags: ["Search"],
      summary: "Search the index",
      description:
        "Hybrid org-scoped retrieval (semantic vector + full-text, merged with RRF) over indexed content. Results are filtered by the caller's ACL (org-visible objects plus their own private ones). The bytes of a hit are read by `storageObjectId` through the storage API.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["query"],
              properties: {
                query: { type: "string", minLength: 1, maxLength: 1000 },
                limit: {
                  type: "integer",
                  minimum: 1,
                  maximum: 50,
                  default: 10,
                  description: "Max hits to return",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Ranked hits",
          headers: stdHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: { type: "array", items: { $ref: "#/components/schemas/SearchHit" } },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
