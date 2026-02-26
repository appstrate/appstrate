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
            },
          },
        },
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
            },
          },
        },
      },
    },
  },

  "/api/connection-profiles/connections": {
    delete: {
      operationId: "deleteAllUserConnections",
      tags: ["Connection Profiles"],
      summary: "Delete all user connections",
      description: "Delete all service connections across all profiles for the authenticated user.",
      responses: {
        "200": {
          description: "Connections deleted",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
    get: {
      operationId: "listAllUserConnections",
      tags: ["Connection Profiles"],
      summary: "List all user connections",
      description:
        "List all service connections across all profiles for the authenticated user, grouped with provider display info.",
      responses: {
        "200": {
          description: "User connections with provider info",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        connectionId: { type: "string", format: "uuid" },
                        providerId: { type: "string" },
                        authMode: { type: "string" },
                        scopesGranted: { type: "array", items: { type: "string" } },
                        connectedAt: { type: "string", format: "date-time" },
                        profile: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            name: { type: "string" },
                            isDefault: { type: "boolean" },
                          },
                        },
                      },
                    },
                  },
                  providerInfo: {
                    type: "object",
                    additionalProperties: {
                      type: "object",
                      properties: {
                        displayName: { type: "string" },
                        logo: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  "/api/connection-profiles/{profileId}": {
    put: {
      operationId: "renameConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Rename a connection profile",
      description: "Update the name of a connection profile owned by the authenticated user.",
      parameters: [
        {
          name: "profileId",
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
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "deleteConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Delete a connection profile",
      description:
        "Delete a non-default connection profile. Fails if the profile is the user's default or is bound to a flow admin connection.",
      parameters: [
        {
          name: "profileId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Profile deleted",
          content: {
            "application/json": {
              schema: { type: "object", properties: { ok: { type: "boolean" } } },
            },
          },
        },
        "400": { description: "Cannot delete (default or bound)" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/connection-profiles/{profileId}/connections": {
    get: {
      operationId: "listProfileConnections",
      tags: ["Connection Profiles"],
      summary: "List connections for a profile",
      description: "List all service connections associated with a specific connection profile.",
      parameters: [
        {
          name: "profileId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Connection list",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  connections: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid" },
                        providerId: { type: "string" },
                        authMode: { type: "string" },
                        scopesGranted: { type: "array", items: { type: "string" } },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
};
