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
                properties: {
                  proxies: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgProxy" },
                  },
                },
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
                label: { type: "string", description: "Display name for the proxy" },
                url: { type: "string", description: "Proxy URL (http://user:pass@host:port)" },
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
                type: "object",
                properties: {
                  id: { type: "string" },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
          description: "Default proxy updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { success: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
                label: { type: "string" },
                url: { type: "string" },
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
              schema: { type: "object", properties: { id: { type: "string" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
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
        "404": {
          description: "Proxy not found",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TestResult" },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { description: "Rate limited" },
      },
    },
  },
} as const;
