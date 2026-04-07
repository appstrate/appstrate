// SPDX-License-Identifier: Apache-2.0

export const connectionProfilesPaths = {
  "/api/connection-profiles": {
    get: {
      operationId: "listConnectionProfiles",
      tags: ["Connection Profiles"],
      summary: "List connection profiles",
      description:
        "List all connection profiles for the authenticated user, including a connection count per profile.",
      responses: {
        "200": {
          description: "Profile list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  profiles: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        name: { type: "string" },
                        isDefault: { type: "boolean" },
                        connectionCount: { type: "integer" },
                        createdAt: { type: "string", format: "date-time" },
                        updatedAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              example: {
                profiles: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440010",
                    name: "Default",
                    isDefault: true,
                    connectionCount: 3,
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
      operationId: "createConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Create a connection profile",
      description: "Create a new named connection profile for the authenticated user.",
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
          description: "Profile created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  profile: {
                    type: "object",
                    properties: {
                      id: { type: "string", format: "uuid" },
                      name: { type: "string" },
                      isDefault: { type: "boolean" },
                      createdAt: { type: "string", format: "date-time" },
                    },
                  },
                },
              },
              example: {
                profile: {
                  id: "550e8400-e29b-41d4-a716-446655440011",
                  name: "Work Profile",
                  isDefault: false,
                  createdAt: "2026-01-15T10:30:00Z",
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },

  "/api/connection-profiles/{id}": {
    put: {
      operationId: "renameConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Rename a connection profile",
      description: "Update the name of a connection profile owned by the authenticated user.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
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
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Delete a connection profile",
      description:
        "Delete a non-default connection profile. Fails if the profile is the user's default or is bound to an agent provider binding.",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Profile deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "400": { description: "Cannot delete (default or bound)" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
};
