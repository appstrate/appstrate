// SPDX-License-Identifier: Apache-2.0

export const metaPaths = {
  "/api/openapi.json": {
    get: {
      operationId: "getOpenApiSpec",
      tags: ["Meta"],
      summary: "OpenAPI specification",
      description: "Returns the OpenAPI 3.1 specification as JSON.",
      security: [],
      responses: {
        "200": {
          description: "OpenAPI spec",
          content: {
            "application/json": {
              schema: { type: "object" },
            },
          },
        },
      },
    },
  },
  "/api/docs": {
    get: {
      operationId: "getSwaggerUI",
      tags: ["Meta"],
      summary: "Swagger UI",
      description: "Interactive API documentation via Swagger UI.",
      security: [],
      responses: {
        "200": {
          description: "HTML page",
          content: {
            "text/html": {
              schema: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;
