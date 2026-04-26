// SPDX-License-Identifier: Apache-2.0

export const appProfilesPaths = {
  "/api/app-profiles/connections": {
    delete: {
      operationId: "deleteAllUserConnections",
      tags: ["App Profiles"],
      summary: "Delete all user connections",
      description:
        "Delete all provider connections across all profiles for the authenticated user.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
              example: { ok: true },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    get: {
      operationId: "listAllUserConnections",
      tags: ["App Profiles"],
      summary: "List all user connections",
      description:
        "List all provider connections across all profiles and organizations for the authenticated user, grouped by provider then by organization.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
              example: {
                providers: [
                  {
                    providerId: "@appstrate/gmail",
                    displayName: "Gmail",
                    logo: "gmail.svg",
                    totalConnections: 1,
                    orgs: [
                      {
                        orgId: "550e8400-e29b-41d4-a716-446655440000",
                        orgName: "Acme Corp",
                        connections: [
                          {
                            connectionId: "550e8400-e29b-41d4-a716-446655440020",
                            scopesGranted: ["https://mail.google.com/"],
                            connectedAt: "2026-01-12T09:00:00Z",
                            profile: {
                              id: "550e8400-e29b-41d4-a716-446655440010",
                              name: "Default",
                              isDefault: true,
                            },
                          },
                        ],
                      },
                    ],
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
                },
              },
              example: {
                profiles: [
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
                properties: {
                  profiles: {
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
                },
              },
              example: {
                profiles: [
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

  "/api/app-profiles/{id}/bindings": {
    get: {
      operationId: "listAppProfileBindings",
      tags: ["App Profiles"],
      summary: "List provider bindings for an app profile",
      description:
        "List all provider bindings for an app profile. Each binding maps a provider to a user's personal connection profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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

  "/api/app-profiles/{id}/bind": {
    post: {
      operationId: "bindAppProfileProvider",
      tags: ["App Profiles"],
      summary: "Bind a provider to a user's connection",
      description:
        "Bind an app profile's provider slot to the requesting user's personal connection profile.",
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
              required: ["providerId", "sourceProfileId"],
              properties: {
                providerId: { type: "string", minLength: 1 },
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

  "/api/app-profiles/{id}/bind/{providerScope}/{providerName}": {
    delete: {
      operationId: "unbindAppProfileProvider",
      tags: ["App Profiles"],
      summary: "Unbind a provider from an app profile",
      description: "Remove a provider binding from an app profile.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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

  "/api/app-profiles/{id}/connections": {
    get: {
      operationId: "listProfileConnections",
      tags: ["App Profiles"],
      summary: "List connections for a profile",
      description:
        "List all provider connections associated with a connection profile. Accessible for own profiles, org-level profiles, and other org members' profiles (read-only).",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
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
} as const;
