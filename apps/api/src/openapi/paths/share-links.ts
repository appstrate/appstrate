export const shareLinksPaths = {
  "/api/flows/{scope}/{name}/share-links": {
    get: {
      operationId: "listShareLinks",
      tags: ["Share Links"],
      summary: "List share links for a flow",
      description: "Returns all share links for the given flow. Admin only.",
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "List of share links",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", const: "list" },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ShareLink" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      operationId: "createShareLink",
      tags: ["Share Links"],
      summary: "Create a share link",
      description:
        "Generate a public share link for the flow. Admin only. Optionally set label, maxUses, expiration, and version snapshot.",
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: {
                  type: ["string", "null"],
                  maxLength: 100,
                  description: "Optional label for the share link",
                },
                maxUses: {
                  type: ["integer", "null"],
                  minimum: 1,
                  description: "Maximum number of uses (null = unlimited, default = 1)",
                },
                expiresInDays: {
                  type: "integer",
                  minimum: 1,
                  maximum: 365,
                  description: "Expiration in days (default: 7)",
                },
                version: {
                  type: "string",
                  description: "Snapshot a specific version instead of current draft",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Share link created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShareLink" },
            },
          },
        },
        "400": {
          description: "Flow cannot be shared (user-mode providers or unbound admin providers)",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/share-links/{linkId}": {
    get: {
      operationId: "getShareLink",
      tags: ["Share Links"],
      summary: "Get share link detail",
      description: "Returns details for a specific share link. Admin only.",
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "linkId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Share link detail",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShareLink" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    patch: {
      operationId: "updateShareLink",
      tags: ["Share Links"],
      summary: "Update a share link",
      description: "Update label, maxUses, isActive, or expiresAt on a share link. Admin only.",
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "linkId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: { type: ["string", "null"], maxLength: 100 },
                maxUses: { type: ["integer", "null"], minimum: 1 },
                isActive: { type: "boolean" },
                expiresAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated share link",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ShareLink" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteShareLink",
      tags: ["Share Links"],
      summary: "Delete a share link",
      description: "Permanently delete a share link and all its usage records. Admin only.",
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "linkId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Share link deleted" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/flows/{scope}/{name}/share-links/{linkId}/usages": {
    get: {
      operationId: "listShareLinkUsages",
      tags: ["Share Links"],
      summary: "List share link usages",
      description: "Returns usage history for a share link.",
      parameters: [
        { name: "scope", in: "path", required: true, schema: { type: "string" } },
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        { name: "linkId", in: "path", required: true, schema: { type: "string" } },
        {
          name: "limit",
          in: "query",
          schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
      ],
      responses: {
        "200": {
          description: "List of usages",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  object: { type: "string", const: "list" },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/ShareLinkUsage" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
