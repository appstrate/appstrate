// SPDX-License-Identifier: Apache-2.0

export const proxiesPaths = {
  "/api/proxies": {
    get: {
      operationId: "listProxies",
      tags: ["Proxies"],
      summary: "List organization proxies",
      description: "Returns all proxies (built-in + custom) for the current organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Proxy list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["object", "data", "hasMore"],
                properties: {
                  object: { type: "string", enum: ["list"] },
                  data: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgProxy" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "cm6pqr678",
                    label: "US Residential Proxy",
                    urlPrefix: "http://user:****@us-proxy.example.com:8080",
                    source: "custom",
                    enabled: true,
                    isDefault: false,
                    created_by: "usr_k7x9m2p4q1",
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    post: {
      operationId: "createProxy",
      tags: ["Proxies"],
      summary: "Create a custom proxy",
      description: "Create a new custom proxy for the organization.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["label", "url"],
              properties: {
                label: { type: "string", minLength: 1, description: "Display name for the proxy" },
                url: {
                  type: "string",
                  format: "uri",
                  description: "Proxy URL (http://user:pass@host:port)",
                },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Proxy created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrgProxy",
                description:
                  "The bare created proxy resource — same shape as the `GET /api/proxies` list items — so no follow-up GET is needed.",
              },
              example: {
                id: "cm6pqr679",
                label: "US Residential Proxy",
                urlPrefix: "http://user:****@us-proxy.example.com:8080",
                source: "custom",
                enabled: true,
                isDefault: false,
                created_by: "usr_k7x9m2p4q1",
                createdAt: "2026-01-10T08:00:00Z",
                updatedAt: "2026-01-10T08:00:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/proxies/default": {
    put: {
      operationId: "setDefaultProxy",
      tags: ["Proxies"],
      summary: "Set the organization default proxy",
      description:
        "Set or unset the default proxy for the organization. Pass null to remove the default.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["proxyId"],
              properties: {
                proxyId: {
                  type: ["string", "null"],
                  description: "Proxy ID to set as default, or null to unset",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description:
            "Default proxy updated — the bare *effective* default proxy resource (same shape as the `GET /api/proxies` list items). When no DB row is flagged, the system-default fallback (if any) is surfaced.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgProxy" },
              example: {
                id: "cm6pqr679",
                label: "US Residential Proxy",
                urlPrefix: "http://user:****@us-proxy.example.com:8080",
                source: "custom",
                enabled: true,
                isDefault: true,
                created_by: "usr_k7x9m2p4q1",
                createdAt: "2026-01-10T08:00:00Z",
                updatedAt: "2026-01-10T08:00:00Z",
              },
            },
          },
        },
        "204": {
          description:
            "Default unset and no proxy remains in effect (no system default configured) — no resource to return.",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/proxies/{id}": {
    put: {
      operationId: "updateProxy",
      tags: ["Proxies"],
      summary: "Update a custom proxy",
      description:
        "Update a custom proxy (label, url, enabled). Built-in proxies cannot be modified.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                label: { type: "string", minLength: 1 },
                url: { type: "string", format: "uri" },
                enabled: { type: "boolean" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Proxy updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/OrgProxy",
                description:
                  "The bare updated proxy resource — same shape as the `GET /api/proxies` list items — so no follow-up GET is needed.",
              },
              example: {
                id: "cm6pqr679",
                label: "US Residential Proxy",
                urlPrefix: "http://user:****@us-proxy.example.com:8080",
                source: "custom",
                enabled: true,
                isDefault: false,
                created_by: "usr_k7x9m2p4q1",
                createdAt: "2026-01-10T08:00:00Z",
                updatedAt: "2026-01-12T09:00:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
    delete: {
      operationId: "deleteProxy",
      tags: ["Proxies"],
      summary: "Delete a custom proxy",
      description: "Delete a custom proxy. Built-in proxies cannot be deleted.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": {
          description: "Proxy deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "500": { $ref: "#/components/responses/InternalServerError" },
      },
    },
  },
  "/api/proxies/{id}/test": {
    post: {
      operationId: "testProxy",
      tags: ["Proxies"],
      summary: "Test proxy connection",
      description:
        "Test that the proxy is reachable by making a lightweight request through it. Rate limited to 5 requests per minute.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Test result",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
