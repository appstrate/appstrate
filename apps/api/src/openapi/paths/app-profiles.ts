// SPDX-License-Identifier: Apache-2.0

export const appProfilesPaths = {
  "/api/app-profiles/my-bindings": {
    get: {
      operationId: "listMyAppBindings",
      tags: ["App Profiles"],
      summary: "List app profiles using my bindings",
      description:
        "List all application-level connection profiles where the authenticated user has bound provider connections.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "App profiles with user's connections",
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
                    items: {
                      type: "object",
                      properties: {
                        profile: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            name: { type: "string" },
                            applicationId: { type: "string" },
                          },
                        },
                        providerIds: {
                          type: "array",
                          items: { type: "string" },
                        },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    profile: {
                      id: "550e8400-e29b-41d4-a716-446655440030",
                      name: "Shared Production",
                      applicationId: "app_cm4jkl013",
                    },
                    providerIds: ["@appstrate/gmail", "@appstrate/clickup"],
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },

  "/api/app-profiles": {
    get: {
      operationId: "listAppConnectionProfiles",
      tags: ["App Profiles"],
      summary: "List app connection profiles",
      description: "List all application-level shared connection profiles with connection counts.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      responses: {
        "200": {
          description: "App profile list",
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
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        name: { type: "string" },
                        applicationId: { type: "string" },
                        connectionCount: { type: "integer" },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440030",
                    name: "Shared Production",
                    applicationId: "app_cm4jkl013",
                    connectionCount: 2,
                    createdAt: "2026-01-10T08:00:00Z",
                    updatedAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    post: {
      operationId: "createAppConnectionProfile",
      tags: ["App Profiles"],
      summary: "Create an app connection profile",
      description: "Create a new application-level shared connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "App profile created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },

  "/api/app-profiles/{id}": {
    put: {
      operationId: "renameAppConnectionProfile",
      tags: ["App Profiles"],
      summary: "Rename an app connection profile",
      description: "Update the name of an application-level connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Profile renamed",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteAppConnectionProfile",
      tags: ["App Profiles"],
      summary: "Delete an app connection profile",
      description: "Delete an application-level connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": {
          description: "Profile deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/app-profiles/{id}/agents": {
    get: {
      operationId: "listAppProfileAgents",
      tags: ["App Profiles"],
      summary: "List agents using an app profile",
      description:
        "List all agents that are configured to use a specific application-level connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": {
          description: "Agent list",
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
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        displayName: { type: "string" },
                      },
                    },
                  },
                  hasMore: { type: "boolean" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
