// SPDX-License-Identifier: Apache-2.0

export const metaPaths = {
  "/api/openapi.json": {
    get: {
      operationId: "getOpenApiSpec",
      tags: ["Meta"],
      summary: "OpenAPI specification",
      description:
        "Returns the OpenAPI 3.1 specification as JSON. The response carries a strong `ETag` " +
        "that is stable for the lifetime of the deployment — send it back as `If-None-Match` " +
        "to revalidate a cached copy and get a `304 Not Modified` instead of the full document.",
      security: [],
      parameters: [
        {
          name: "If-None-Match",
          in: "header",
          required: false,
          description: "Entity-tag of a cached copy. A match yields `304 Not Modified`.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "OpenAPI spec",
          headers: {
            ETag: {
              description: "Strong entity-tag of the served specification.",
              schema: { type: "string" },
            },
          },
          content: {
            "application/json": {
              schema: { type: "object" },
              example: {
                openapi: "3.1.0",
                info: { title: "Appstrate API", version: "2026-03-21" },
              },
            },
          },
        },
        "304": {
          description: "Cached copy is still current (`If-None-Match` matched). No body.",
          headers: {
            ETag: {
              description: "Strong entity-tag of the served specification.",
              schema: { type: "string" },
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
