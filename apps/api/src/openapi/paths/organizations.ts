// SPDX-License-Identifier: Apache-2.0

import { ASSIGNABLE_ROLES } from "../../services/invitations.ts";

export const organizationsPaths = {
  "/api/orgs": {
    get: {
      operationId: "listOrganizations",
      tags: ["Organizations"],
      summary: "List user organizations",
      description: "List organizations the current user is a member of.",
      responses: {
        "200": {
          description: "Organization list",
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
                    items: { $ref: "#/components/schemas/Organization" },
                  },
                  hasMore: { type: "boolean" },
                },
              },
              example: {
                object: "list",
                hasMore: false,
                data: [
                  {
                    id: "550e8400-e29b-41d4-a716-446655440000",
                    name: "Acme Corp",
                    slug: "acme-corp",
                    role: "owner",
                    createdAt: "2026-01-10T08:00:00Z",
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
      operationId: "createOrganization",
      tags: ["Organizations"],
      summary: "Create an organization",
      description:
        "Create a new organization. The current user becomes the owner. The organization is automatically pinned to the current API version.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name"],
              properties: {
                name: { type: "string", minLength: 1 },
                slug: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "Organization created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  name: { type: "string" },
                  slug: { type: "string" },
                  role: { type: "string", enum: ["owner"] },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
              example: {
                id: "550e8400-e29b-41d4-a716-446655440001",
                name: "New Organization",
                slug: "new-org",
                role: "owner",
                createdAt: "2026-01-15T10:30:00Z",
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/orgs/{orgId}": {
    get: {
      operationId: "getOrganization",
      tags: ["Organizations"],
      summary: "Get organization with members",
      description: "Get organization details including members and pending invitations.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Organization detail with members and invitations",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgDetail" },
              example: {
                id: "550e8400-e29b-41d4-a716-446655440000",
                name: "Acme Corp",
                slug: "acme-corp",
                members: [
                  {
                    userId: "usr_abc123",
                    displayName: "Alice",
                    email: "alice@acme.com",
                    role: "owner",
                    joinedAt: "2026-01-10T08:00:00Z",
                  },
                  {
                    userId: "usr_def456",
                    displayName: "Bob",
                    email: "bob@acme.com",
                    role: "member",
                    joinedAt: "2026-01-12T10:00:00Z",
                  },
                ],
                invitations: [],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
    put: {
      operationId: "updateOrganization",
      tags: ["Organizations"],
      summary: "Update organization",
      description: "Update organization name. Owner only.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                name: { type: "string", minLength: 1 },
                slug: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Organization updated",
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
                  name: { type: "string" },
                  slug: { type: "string" },
                  createdBy: { type: "string" },
                  createdAt: { type: "string", format: "date-time" },
                  updatedAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    delete: {
      operationId: "deleteOrganization",
      tags: ["Organizations"],
      summary: "Delete organization",
      description: "Delete organization and all associated data. Owner only.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Organization deleted",
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
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/orgs/{orgId}/members": {
    post: {
      operationId: "addOrInviteMember",
      tags: ["Organizations"],
      summary: "Add or invite a member",
      description:
        "Add a user to the org (if they exist) or create an invitation with a magic link token.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["email", "role"],
              properties: {
                email: { type: "string", format: "email" },
                role: { type: "string", enum: [...ASSIGNABLE_ROLES], default: "member" },
              },
            },
          },
        },
      },
      responses: {
        "201": {
          description: "User added or invitation created",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  added: { type: "boolean", description: "True if user was added directly" },
                  invited: { type: "boolean", description: "True if invitation was sent" },
                  userId: { type: "string", description: "User ID (if added)" },
                  email: { type: "string", description: "Email (if invited)" },
                  role: { type: "string" },
                  token: {
                    type: "string",
                    description: "Invitation token (only if invited)",
                  },
                },
              },
              example: {
                added: false,
                invited: true,
                email: "newuser@example.com",
                role: "member",
                token: "inv_abc123def456",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/orgs/{orgId}/members/{userId}": {
    put: {
      operationId: "changeMemberRole",
      tags: ["Organizations"],
      summary: "Change member role",
      description: "Change a member's role within the organization. Owner only.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["role"],
              properties: {
                role: { type: "string", enum: [...ASSIGNABLE_ROLES] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Role updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  userId: { type: "string" },
                  role: { type: "string", enum: [...ASSIGNABLE_ROLES] },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "removeMember",
      tags: ["Organizations"],
      summary: "Remove a member",
      description: "Remove a member from the organization.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Member removed",
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/orgs/{orgId}/invitations/{invitationId}": {
    put: {
      operationId: "changeInvitationRole",
      tags: ["Organizations"],
      summary: "Change invitation role",
      description: "Change the role assigned to a pending invitation. Owner only.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "invitationId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["role"],
              properties: {
                role: { type: "string", enum: [...ASSIGNABLE_ROLES] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Invitation role updated",
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
                  role: { type: "string", enum: [...ASSIGNABLE_ROLES] },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "cancelInvitation",
      tags: ["Organizations"],
      summary: "Cancel an invitation",
      description: "Cancel a pending invitation.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "invitationId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Invitation cancelled",
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
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/api/orgs/{orgId}/settings": {
    get: {
      operationId: "getOrgSettings",
      tags: ["Organizations"],
      summary: "Get organization settings",
      description: "Get organization settings (redirect domains, etc.).",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "Organization settings",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgSettings" },
              example: {
                apiVersion: "2026-03-21",
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
    put: {
      operationId: "updateOrgSettings",
      tags: ["Organizations"],
      summary: "Update organization settings",
      description: "Update organization settings (merge — only provided fields are updated).",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/OrgSettings" },
          },
        },
      },
      responses: {
        "200": {
          description: "Settings updated",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgSettings" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
