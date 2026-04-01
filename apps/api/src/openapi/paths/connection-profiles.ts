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
        "Delete a non-default connection profile. Fails if the profile is the user's default or is bound to a flow provider binding.",
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

  "/api/connection-profiles/my-org-bindings": {
    get: {
      operationId: "listMyOrgBindings",
      tags: ["Connection Profiles"],
      summary: "List org profiles using my bindings",
      description:
        "List all org-level connection profiles where the authenticated user has bound provider connections.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Org profiles with user's connections",
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
                        profile: {
                          type: "object",
                          properties: {
                            id: { type: "string", format: "uuid" },
                            name: { type: "string" },
                            orgId: { type: "string", format: "uuid" },
                          },
                        },
                        providerIds: {
                          type: "array",
                          items: { type: "string" },
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

  "/api/connection-profiles/org": {
    get: {
      operationId: "listOrgConnectionProfiles",
      tags: ["Connection Profiles"],
      summary: "List org connection profiles",
      description: "List all organization-level shared connection profiles with connection counts.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Org profile list",
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
                        orgId: { type: "string", format: "uuid" },
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
      operationId: "createOrgConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Create an org connection profile",
      description: "Create a new organization-level shared connection profile. Admin only.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
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
          description: "Org profile created",
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

  "/api/connection-profiles/org/{id}": {
    put: {
      operationId: "renameOrgConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Rename an org connection profile",
      description: "Update the name of an org-level connection profile. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
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
      operationId: "deleteOrgConnectionProfile",
      tags: ["Connection Profiles"],
      summary: "Delete an org connection profile",
      description: "Delete an org-level connection profile. Admin only.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
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

  "/api/connection-profiles/org/{id}/flows": {
    get: {
      operationId: "listOrgProfileFlows",
      tags: ["Connection Profiles"],
      summary: "List flows using an org profile",
      description:
        "List all flows that are configured to use a specific org-level connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": {
          description: "Flow list",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  flows: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        displayName: { type: "string" },
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

  "/api/connection-profiles/org/{id}/bindings": {
    get: {
      operationId: "listOrgProfileBindings",
      tags: ["Connection Profiles"],
      summary: "List provider bindings for an org profile",
      description:
        "List all provider bindings for an org profile. Each binding maps a provider to a user's personal connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      responses: {
        "200": {
          description: "Bindings map (providerId → sourceProfileId)",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/connection-profiles/org/{id}/bind": {
    post: {
      operationId: "bindOrgProfileProvider",
      tags: ["Connection Profiles"],
      summary: "Bind a provider to a user's connection",
      description:
        "Bind an org profile's provider slot to the requesting user's personal connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["providerId", "sourceProfileId"],
              properties: {
                providerId: { type: "string" },
                sourceProfileId: { type: "string", format: "uuid" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Provider bound",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
        "400": { description: "Source profile not found or no active connection" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },

  "/api/connection-profiles/org/{id}/bind/{providerScope}/{providerName}": {
    delete: {
      operationId: "unbindOrgProfileProvider",
      tags: ["Connection Profiles"],
      summary: "Unbind a provider from an org profile",
      description: "Remove a provider binding from an org profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        {
          name: "providerScope",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "providerName",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Provider unbound",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
        },
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
