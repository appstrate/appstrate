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
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  organizations: {
                    type: "array",
                    items: { $ref: "#/components/schemas/Organization" },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      operationId: "createOrganization",
      tags: ["Organizations"],
      summary: "Create an organization",
      description: "Create a new organization. The current user becomes the owner.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["name", "slug"],
              properties: {
                name: { type: "string" },
                slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
              },
            },
          },
        },
      },
      responses: {
        "201": { description: "Organization created" },
        "400": { $ref: "#/components/responses/ValidationError" },
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
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OrgDetail" },
            },
          },
        },
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
                name: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Organization updated" },
      },
    },
    delete: {
      operationId: "deleteOrganization",
      tags: ["Organizations"],
      summary: "Delete organization",
      description: "Delete organization and all associated data. Owner only.",
      parameters: [{ name: "orgId", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "204": { description: "Organization deleted" },
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
              required: ["email"],
              properties: {
                email: { type: "string", format: "email" },
                role: { type: "string", enum: ["admin", "member"], default: "member" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "User added or invitation created",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  invited: { type: "boolean" },
                  added: { type: "boolean" },
                  token: {
                    type: "string",
                    description: "Invitation token (only if invited)",
                  },
                },
              },
            },
          },
        },
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
                role: { type: "string", enum: ["admin", "member"] },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Role updated" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "removeMember",
      tags: ["Organizations"],
      summary: "Remove a member",
      description: "Remove a member from the organization. Admin or owner only.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "userId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Member removed" },
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
                role: { type: "string", enum: ["admin", "member"] },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "Invitation role updated" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "cancelInvitation",
      tags: ["Organizations"],
      summary: "Cancel an invitation",
      description: "Cancel a pending invitation. Admin or owner only.",
      parameters: [
        { name: "orgId", in: "path", required: true, schema: { type: "string" } },
        { name: "invitationId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Invitation cancelled" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
