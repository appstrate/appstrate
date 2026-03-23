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
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },

  "/api/connection-profiles/connections": {
    delete: {
      operationId: "deleteAllUserConnections",
      tags: ["Connection Profiles"],
      summary: "Delete all user connections",
      description:
        "Delete all provider connections across all profiles for the authenticated user.",
      responses: {
        "200": {
          description: "Connections deleted",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    get: {
      operationId: "listAllUserConnections",
      tags: ["Connection Profiles"],
      summary: "List all user connections",
      description:
        "List all provider connections across all profiles and organizations for the authenticated user, grouped by provider then by organization.",
      responses: {
        "200": {
          description: "User connections grouped by provider and organization",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  providers: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        providerId: { type: "string" },
                        displayName: { type: "string" },
                        logo: { type: "string" },
                        totalConnections: { type: "integer" },
                        orgs: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              orgId: { type: "string", format: "uuid" },
                              orgName: { type: "string" },
                              connections: {
                                type: "array",
                                items: {
                                  type: "object",
                                  properties: {
                                    connectionId: { type: "string", format: "uuid" },
                                    scopesGranted: {
                                      type: "array",
                                      items: { type: "string" },
                                    },
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
        "Delete a non-default connection profile. Fails if the profile is the user's default or is bound to a flow admin connection.",
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

  "/api/connection-profiles/{id}/connections": {
    get: {
      operationId: "listProfileConnections",
      tags: ["Connection Profiles"],
      summary: "List connections for a profile",
      description:
        "List all provider connections associated with a specific connection profile in the current organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      responses: {
        "200": {
          description: "Connection list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
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
                        profileId: { type: "string", format: "uuid" },
                        providerId: { type: "string" },
                        orgId: { type: "string", format: "uuid" },
                        scopesGranted: { type: "array", items: { type: "string" } },
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
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
};
